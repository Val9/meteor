Meteor.ui = Meteor.ui || {};

//// not all chunks have html_func??
//// ranged_html -> chunk
//// merge replace_contents and intelligent_replace, unify cleanup and secondary events?
//// callbacks processed inside onupdate?
//// patchContents?
//// Meteor.ui.chunk with a string?  Route everything through ui.chunk/ui.render?

// Game plan:
// - renderContents / patch separately
// - onadded callback instead of onlive (track chunks)
// - use onadded for secondary event attachment

// events (onlive?) on update??

// render calls Meteor.ui.render; calls Meteor.ui.chunk

// PROBLEM: where to attach_events?  was in renderFragment before,
// but now needs to be after patchContents.
// IDEA: hook up after update, through something like onlive, somehow?
// OR: can we transplant the events???

// focus on SIGNALS: "added", "kill", "update"... list callbacks?

(function() {

  var walkRanges = function(frag, originalHtml, idToChunk) {
    // Helper that invokes `f` on every comment node under `parent`.
    // If `f` returns a node, visit that node next.
    var each_comment = function(parent, f) {
      for (var n = parent.firstChild; n;) {
        if (n.nodeType === 8) { // comment
          n = f(n) || n.nextSibling;
          continue;
        } else if (n.nodeType === 1) { // element
          each_comment(n, f);
        }
        n = n.nextSibling;
      }
    };

    // walk comments and create ranges
    var rangeStartNodes = {};
    var liveChunks = [];
    each_comment(frag, function(n) {

      var rangeCommentMatch = /^\s*(START|END)RANGE_(\S+)/.exec(n.nodeValue);
      if (! rangeCommentMatch)
        return null;

      var which = rangeCommentMatch[1];
      var id = rangeCommentMatch[2];

      if (which === "START") {
        if (rangeStartNodes[id])
          throw new Error("The return value of chunk can only be used once.");
        rangeStartNodes[id] = n;

        return null;
      }
      // else: which === "END"

      var startNode = rangeStartNodes[id];
      var endNode = n;
      var next = endNode.nextSibling;

      // try to remove comments
      var a = startNode, b = endNode;
      if (a.nextSibling && b.previousSibling) {
        if (a.nextSibling === b) {
          // replace two adjacent comments with one
          endNode = startNode;
          b.parentNode.removeChild(b);
          startNode.nodeValue = 'placeholder';
        } else {
          // remove both comments
          startNode = startNode.nextSibling;
          endNode = endNode.previousSibling;
          a.parentNode.removeChild(a);
          b.parentNode.removeChild(b);
        }
      } else {
        /* shouldn't happen; invalid HTML? */
      }

      if (startNode.parentNode !== endNode.parentNode) {
        // Try to fix messed-up comment ranges like
        // <!-- #1 --><tbody> ... <!-- /#1 --></tbody>,
        // which are extremely common with tables.  Tests
        // fail in all browsers without this code.
        if (startNode === endNode.parentNode ||
            startNode === endNode.parentNode.previousSibling) {
          startNode = endNode.parentNode.firstChild;
        } else if (endNode === startNode.parentNode ||
                   endNode === startNode.parentNode.nextSibling) {
          endNode = startNode.parentNode.lastChild;
        } else {
          var html = originalHtml;
          var r = new RegExp('<!--\\s*STARTRANGE_'+id+'.*?-->', 'g');
          var match = r.exec(html);
          var help = "";
          if (match) {
            var comment_end = r.lastIndex;
            var comment_start = comment_end - match[0].length;
            var stripped_before = html.slice(0, comment_start).replace(
                /<!--\s*(START|END)RANGE.*?-->/g, '');
            var stripped_after = html.slice(comment_end).replace(
                /<!--\s*(START|END)RANGE.*?-->/g, '');
            var context_amount = 50;
            var context = stripped_before.slice(-context_amount) +
                  stripped_after.slice(0, context_amount);
            help = " (possible unclosed near: "+context+")";
          }
          throw new Error("Could not create liverange in template. "+
                          "Check for unclosed tags in your HTML."+help);
        }
      }

      var range = new Meteor.ui._LiveRange(Meteor.ui._tag, startNode, endNode);
      var chunk = idToChunk[id];
      if (chunk) {
        chunk.range = range;
        range.chunk = chunk;
        liveChunks.push(chunk);
      }

      return next;
    });

    return liveChunks;
  };

  var renderHtml = function(html_func, context) {
    var html = context.run(html_func);

    if (typeof html !== "string")
      throw new Error("Render function must return a string");

    return html;
  };

  var renderFragment = function(html_func) {

    var idToChunk = {};
    Meteor.ui._render_mode = {
      nextId: 1,
      idToChunk: idToChunk
    };

    var html;
    try {
      html = html_func();
    } finally {
      Meteor.ui._render_mode = null;
    }

    var frag = Meteor.ui._htmlToFragment(html);
    if (! frag.firstChild)
      frag.appendChild(document.createComment("empty"));

    var liveChunks = walkRanges(frag, html, idToChunk);

    _.each(liveChunks, function(ch) {
      ch._send("added"); // first message in the chunk's queue!
    });

    return {frag:frag, liveChunks:liveChunks};

    // XXX caller must attach events later
  };

  var patchContents = function(chunk, frag) {
    Meteor.ui._intelligent_replace(chunk.range, frag);
  };

  // In render mode (i.e. inside Meteor.ui.render), this is an
  // object, otherwise it is null.
  // callbacks: id -> func, where id ranges from 1 to callbacks._count.
  Meteor.ui._render_mode = null;

  Meteor.ui.render = function (html_func, options) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.render() requires a function as its first argument.");

    if (Meteor.ui._render_mode)
      throw new Error("Can't nest Meteor.ui.render.");

    var result = renderFragment(function() {
      return Meteor.ui.chunk(html_func, options);
    });
    _.each(result.liveChunks, function(c) {
      attach_events(c.range);
    });

    return result.frag;
  };

  Meteor.ui.chunk = function(html_func, options) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.chunk() requires a function as its first argument.");

    var c = new Chunk(options);
    if (options && options.oninit)
      options.oninit.call(c);

    var html = renderHtml(
      _.bind(html_func, null, c.data()), c._context);

    if (! Meteor.ui._render_mode)
      // Just return the HTML.
      return html;

    // Reactive case:

    c.onupdate = function() {
      var result = renderFragment(function() {
        // XXX weird
        return c._context.run(function() {
          return html_func(c.data());
        });
      });
      patchContents(c, result.frag);
      attach_events(c.range);
      // XXX duplicated
      _.each(result.liveChunks, function(x) {
        attach_events(x.range);
      });
    };

    if (options) {
      if (options.onupdate)
        c.onupdate = options.onupdate;
      if (options.onadded)
        c.onadded = options.onadded;
      if (options.onkill)
        c.onkill = options.onkill;
    }

    return Meteor.ui._ranged_html(html, c);
  };

  Meteor.ui.listChunk = function (observable, doc_func, else_func, options) {
    if (arguments.length === 3 && typeof else_func === "object") {
      // support (observable, doc_func, options) arguments
      options = else_func;
      else_func = null;
    }

    if (typeof doc_func !== "function")
      throw new Error("Meteor.ui.listChunk() requires a function as first argument");
    else_func = (typeof else_func === "function" ? else_func :
                 function() { return ""; });

    var initialDocs = [];
    var receiver = new Meteor.ui._CallbackReceiver();

    var handle = observable.observe(receiver);
    receiver.flush_to_array(initialDocs);

    var docChunkOptions = function(doc) {
      return {
        oninit: function() { this.doc = doc; },
        data: function() { return this.doc; }
      };
    };

    var oninit = function() {
      var self = this;
      // update this chunk when a data callback happens
      receiver.oncallback = function () {
        self.update();
      };
    };

    var onadded = function() {
      var self = this;

      var chunkList = self.childChunks();
      if (initialDocs.length) {
        self.docChunks = chunkList;
        self.elseChunk = null;
      } else {
        self.docChunks = [];
        self.elseChunk = chunkList[0];
      }
    };

    var onupdate = function() {
      var self = this;

      var docChunk = function(doc) {
        // XXX this is weird.
        // too hard to get the chunk from Meteor.ui.render.
        var chunk;
        var options = docChunkOptions(doc);
        var oldoninit = options.oninit;
        options.oninit = function() {
          oldoninit.call(this);
          chunk = this;
        };
        Meteor.ui.render(doc_func, options);
        return chunk;
      };

      var elseChunk = function() {
        var chunk;
        Meteor.ui.render(else_func,
                         {oninit: function() {
                           chunk = this;
                         }});
        return chunk;
      };

      var insertFrag = function(frag, i) {
        var docChunks = self.docChunks;
        if (i === docChunks.length)
          docChunks[i-1].range.insert_after(frag);
        else
          docChunks[i].range.insert_before(frag);
      };

      var insertChunk = function(newChunk, i) {
        var frag = newChunk.range.containerNode();
        insertFrag(frag, i);
        attach_secondary_events(newChunk.range);
      };

      var extractChunk = function(chunk) {
        var frag = chunk.range.extract();
        if (! frag) {
          // extract() failed because enclosing LiveRange would
          // become empty.  to make this method work in general,
          // do something smart here like replace_contents
          // on the enclosing range with a comment.
          throw new Error("Can't extract only subchunk");
        }
        return frag;
      };

      var replaceContents = function(newChunk) {
        var frag = newChunk.range.containerNode();
        self.range.replace_contents(frag);
        attach_secondary_events(newChunk.range);
      };

      var callbacks = {
        added: function(doc, before_idx) {
          var addedChunk = docChunk(doc);

          if (self.elseChunk) {
            // else case -> one item
            self.elseChunk.kill();
            self.elseChunk = null;
            replaceContents(addedChunk);
          } else {
            insertChunk(addedChunk, before_idx);
          }

          self.docChunks.splice(before_idx, 0, addedChunk);
        },
        removed: function(doc, at_idx) {
          var docChunks = self.docChunks;
          if (docChunks.length === 1) {
            // one item -> else case
            docChunks[0].kill();
            self.elseChunk = elseChunk();
            replaceContents(self.elseChunk);
          } else {
            // remove item
            var removedChunk = docChunks[at_idx];
            extractChunk(removedChunk);
            removedChunk.kill();
          }

          docChunks.splice(at_idx, 1);
        },
        moved: function(doc, old_idx, new_idx) {
          if (old_idx === new_idx)
            return;

          var docChunks = self.docChunks;
          var movedChunk = docChunks[old_idx];
          // We know the list has at least two items,
          // at old_idx and new_idx, so `extract` will
          // succeed.
          var frag = extractChunk(movedChunk);
          // remove chunk from list at old index
          docChunks.splice(old_idx, 1);

          insertFrag(frag, new_idx);
          // insert chunk into list at new index
          docChunks.splice(new_idx, 0, movedChunk);
        },
        changed: function(doc, at_idx) {
          var chunk = self.docChunks[at_idx];
          chunk.doc = doc;
          chunk.update();
        }
      };

      receiver.flush_to(callbacks);
    };

    var onkill = function() {
      handle.stop();
    };

    var html = Meteor.ui.chunk(function() {
      var inner_html;
      if (initialDocs.length === 0) {
        inner_html = Meteor.ui.chunk(else_func);
      } else {
        inner_html = _.map(initialDocs, function(doc) {
          return Meteor.ui.chunk(doc_func, docChunkOptions(doc));
        }).join('');
      }
      return inner_html;
    }, _.extend({onupdate:onupdate, onkill:onkill,
                 onadded:onadded, oninit:oninit}, options));

    if (! Meteor.ui._render_mode)
      // Just return the HTML.
      handle.stop();

    return html;

  };


  Meteor.ui._tag = "_liveui";

  var _checkOffscreen = function(range) {
    var node = range.firstNode();

    if (node.parentNode &&
        (Meteor.ui._onscreen(node) || Meteor.ui._is_held(node)))
      return false;

    cleanup_range(range);

    return true;
  };

  // Internal facility, only used by tests, for holding onto
  // DocumentFragments across flush().  Reference counts
  // using hold() and release().
  Meteor.ui._is_held = function(node) {
    while (node.parentNode)
      node = node.parentNode;

    return node.nodeType !== 3 /*TEXT_NODE*/ && node._liveui_refs;
  };
  Meteor.ui._hold = function(frag) {
    frag._liveui_refs = (frag._liveui_refs || 0) + 1;
  };
  Meteor.ui._release = function(frag) {
    // Clean up on flush, if hits 0.
    // Don't want to decrement
    // _liveui_refs to 0 now because someone else might
    // clean it up if it's not held.
    var cx = new Meteor.deps.Context;
    cx.on_invalidate(function() {
      --frag._liveui_refs;
      if (! frag._liveui_refs)
        cleanup_frag(frag);
    });
    cx.invalidate();
  };

  Meteor.ui._onscreen = function (node) {
    // http://jsperf.com/is-element-in-the-dom

    if (document.compareDocumentPosition)
      return document.compareDocumentPosition(node) & 16;
    else {
      if (node.nodeType !== 1 /* Element */)
        /* contains() doesn't work reliably on non-Elements. Fine on
         Chrome, not so much on Safari and IE. */
        node = node.parentNode;
      if (node.nodeType === 11 /* DocumentFragment */ ||
          node.nodeType === 9 /* Document */)
        /* contains() chokes on DocumentFragments on IE8 */
        return node === document;
      /* contains() exists on document on Chrome, but only on
       document.body on some other browsers. */
      return document.body.contains(node);
    }
  };

  var CallbackReceiver = function() {
    var self = this;

    self.queue = [];
    self.deps = {};

    // attach these callback funcs to each instance, as they may
    // not be called as methods by livedata.
    _.each(["added", "removed", "moved", "changed"], function (name) {
      self[name] = function (/* arguments */) {
        self.queue.push([name].concat(_.toArray(arguments)));
        self.oncallback();
      };
    });
  };

  Meteor.ui._CallbackReceiver = CallbackReceiver;

  CallbackReceiver.prototype.flush_to = function(t) {
    // fire all queued events on new target
    _.each(this.queue, function(x) {
      var name = x[0];
      var args = x.slice(1);
      t[name].apply(t, args);
    });
    this.queue.length = 0;
  };
  CallbackReceiver.prototype.flush_to_array = function(array) {
    // apply all queued events to array
    _.each(this.queue, function(x) {
      switch (x[0]) {
      case 'added': array.splice(x[2], 0, x[1]); break;
      case 'removed': array.splice(x[2], 1); break;
      case 'moved': array.splice(x[3], 0, array.splice(x[2], 1)[0]); break;
      case 'changed': array[x[2]] = x[1]; break;
      }
    });
    this.queue.length = 0;
  };
  CallbackReceiver.prototype.oncallback = function() {}; // to override

  // Performs a replacement by determining which nodes should
  // be preserved and invoking Meteor.ui._Patcher as appropriate.
  Meteor.ui._intelligent_replace = function(tgtRange, srcParent) {

    // Table-body fix:  if tgtRange is in a table and srcParent
    // contains a TR, wrap fragment in a TBODY on all browsers,
    // so that it will display properly in IE.
    if (tgtRange.containerNode().nodeName === "TABLE" &&
        _.any(srcParent.childNodes,
              function(n) { return n.nodeName === "TR"; })) {
      var tbody = document.createElement("TBODY");
      while (srcParent.firstChild)
        tbody.appendChild(srcParent.firstChild);
      srcParent.appendChild(tbody);
    }

    var copyFunc = function(t, s) {
      Meteor.ui._LiveRange.transplant_tag(Meteor.ui._tag, t, s);
    };

    //tgtRange.replace_contents(srcParent);

    tgtRange.operate(function(start, end) {
      // clear all LiveRanges on target
      cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, start, end));

      var patcher = new Meteor.ui._Patcher(
        start.parentNode, srcParent,
        start.previousSibling, end.nextSibling);
      patcher.diffpatch(copyFunc);
    });

    attach_secondary_events(tgtRange);
  };

  var Chunk = function(options) {
    var self = this;

    self._msgs = [];
    self._msgCx = null;

    if (options) {
      if (options.data)
        self.data = options.data;

      // backwards compatibility: event_data -> data
      if (options.event_data)
        self.data = options.event_data;

      if (options.events)
        self.event_handlers = unpackEventMap(options.events);
    }

    // make self.data() a function if it isn't
    if (typeof self.data !== "function") {
      var constantData = self.data;
      self.data = function() { return constantData; };
    }

    // XXX comment
    // Meteor.deps integration.
    // When self._context is invalidated, recreate it
    // and call self.onupdate().
    var ondirty = function() {
      self._send("update");
      self._context = new Meteor.deps.Context;
      self._context.on_invalidate(ondirty);
    };
    self._context = new Meteor.deps.Context;
    self._context.on_invalidate(ondirty);
  };

  Chunk.prototype._send = function(message) {
    var self = this;

    self._msgs.push(message);

    var processMessage = function(msg) {
      if (self.killed)
        return;

      // If chunk is not onscreen at flush time, any message
      // is treated like "kill".  All future messages will be
      // ignored.
      if (msg === "kill" || (! self.range) || _checkOffscreen(self.range)) {
        self.killed = true;
        self._context.invalidate();
        self._context = null;
        self.onkill();
        return;
      }

      if (msg === "added")
        self.onadded();
      else if (msg === "update")
        self.onupdate();
    };

    // schedule message to be processed at flush time
    if (! self._msgCx) {
      var cx = new Meteor.deps.Context;
      cx.on_invalidate(function() {
        self._msgCx = null;
        var msgs = self._msgs;
        self._msgs = [];

        _.each(msgs, processMessage);
      });
      cx.invalidate();
      self._msgCx = cx;
    };
  };

  Chunk.prototype.kill = function() {
    if (! this.killed)
      this._send("kill");
  };

  Chunk.prototype.update = function() {
    this._context.invalidate();
  };

  Chunk.prototype.onupdate = function() {}; // to override

  Chunk.prototype.onkill = function() {}; // to override

  Chunk.prototype.onadded = function() {};

  Chunk.prototype.childChunks = function() {
    if (! this.range)
      throw new Error("Chunk not rendered yet");

    var chunks = [];
    this.range.visit(function(is_start, r) {
      if (! is_start)
        return false;
      if (! r.chunk)
        return true; // allow for intervening LiveRanges
      chunks.push(r.chunk);
      return false;
    });

    return chunks;
  };

  Chunk.prototype.parentChunk = function() {
    if (! this.range)
      throw new Error("Chunk not rendered yet");

    for(var r = this.range.findParent(); r; r = r.findParent())
      if (r.chunk)
        return r.chunk;

    return null;
  };

  Meteor.ui._findChunk = function(node) {
    var range = Meteor.ui._LiveRange.findRange(Meteor.ui._tag, node);

    for(var r = range; r; r = r.findParent())
      if (r.chunk)
        return r.chunk;

    return null;
  };

  // Convert an event map from the developer into an internal
  // format for range.event_handlers.  The internal format is
  // an array of objects with properties {type, selector, callback}.
  // The array has an expando property `types`, which is a list
  // of all the unique event types used (as an optimization for
  // code that needs this info).
  var unpackEventMap = function(events) {
    var handlers = [];

    var eventTypeSet = {};

    // iterate over `spec: callback` map
    _.each(events, function(callback, spec) {
      var clauses = spec.split(/,\s+/);
      // iterate over clauses of spec, e.g. ['click .foo', 'click .bar']
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        var type = parts.shift();
        var selector = parts.join(' ');

        handlers.push({type:type, selector:selector, callback:callback});
        eventTypeSet[type] = true;
      });
    });

    handlers.types = _.keys(eventTypeSet);
    return handlers;
  };

  Meteor.ui._ranged_html = function(html, chunk) {
    if (! Meteor.ui._render_mode)
      return html;

    var idToChunk = Meteor.ui._render_mode.idToChunk;
    var commentId = Meteor.ui._render_mode.nextId ++;

    if (chunk)
      idToChunk[commentId] = chunk;

    return "<!-- STARTRANGE_"+commentId+" -->" + html +
      "<!-- ENDRANGE_"+commentId+" -->";
  };

  var cleanup_frag = function(frag) {
    // wrap the frag in a new LiveRange that will be destroyed
    cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, frag));
  };

  // XXX rewrite comment
  // Cleans up a range and its descendant ranges by calling
  // killContext on them (which removes any associated context
  // from dependency tracking) and then destroy (which removes
  // the liverange data from the DOM).
  var cleanup_range = function(range) {
    range.visit(function(is_start, range) {
      if (is_start)
        range.chunk && range.chunk.kill();
    });
    range.destroy(true);
  };

  // Attach events specified by `range` to top-level nodes in `range`.
  // The nodes may still be in a DocumentFragment.
  var attach_events = function(range) {
    var handlers = range.chunk && range.chunk.event_handlers;
    if (! handlers)
      return;

    _.each(handlers.types, function(t) {
      for(var n = range.firstNode(), after = range.lastNode().nextSibling;
          n && n !== after;
          n = n.nextSibling)
        Meteor.ui._event.registerEventType(t, n);
    });
  };

  // Attach events specified by enclosing ranges of `range`, at the
  // same DOM level, to nodes in `range`.  This is necessary if
  // `range` has just been inserted (as in the case of list 'added'
  // events) or if it has been re-rendered but its enclosing ranges
  // haven't.  In either case, the nodes in `range` have been rendered
  // without taking enclosing ranges into account, so additional event
  // handlers need to be attached.
  var attach_secondary_events = function(range) {
    // Implementations of LiveEvents that use whole-document event capture
    // (all except old IE) don't actually need any of this; this function
    // could be a no-op.
    for(var r = range.findParent(); r; r = r.findParent()) {
      var handlers = r.chunk && r.chunk.event_handlers;
      if (! handlers)
        continue;

      var eventTypes = handlers.types;
      _.each(eventTypes, function(t) {
        for(var n = range.firstNode(), after = range.lastNode().nextSibling;
            n && n !== after;
            n = n.nextSibling)
          Meteor.ui._event.registerEventType(t, n);
      });
    }
  };

  // Handle a currently-propagating event on a particular node.
  // We walk all enclosing liveranges of the node, from the inside out,
  // looking for matching handlers.  If the app calls stopPropagation(),
  // we still call all handlers in all event maps for the current node.
  // If the app calls "stopImmediatePropagation()", we don't call any
  // more handlers.
  Meteor.ui._handleEvent = function(event) {
    var curNode = event.currentTarget;
    if (! curNode)
      return;

    var innerChunk = Meteor.ui._findChunk(curNode);

    var type = event.type;

    for(var chunk = innerChunk; chunk; chunk = chunk.parentChunk()) {
      var event_handlers = chunk.event_handlers;
      if (! event_handlers)
        continue;

      for(var i=0, N=event_handlers.length; i<N; i++) {
        var h = event_handlers[i];

        if (h.type !== type)
          continue;

        var selector = h.selector;
        if (selector) {
          var contextNode = chunk.range.containerNode();
          var results = $(contextNode).find(selector);
          if (! _.contains(results, curNode))
            continue;
        } else {
          // if no selector, only match the event target
          if (curNode !== event.target)
            continue;
        }

        var event_data = findEventData(event.target);

        // Call the app's handler/callback
        var returnValue = h.callback.call(event_data, event);

        // allow app to `return false` from event handler, just like
        // you can in a jquery event handler
        if (returnValue === false) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
        if (event.isImmediatePropagationStopped())
          break; // stop handling by this and other event maps
      }
    }

  };

  // find the innermost enclosing liverange that has event data
  var findEventData = function(node) {
    var innerChunk = Meteor.ui._findChunk(node);

    for(var chunk = innerChunk; chunk; chunk = chunk.parentChunk()) {
      var data = chunk.data();
      if (data)
        return data;
    }

    return null;
  };

  Meteor.ui._event.setHandler(Meteor.ui._handleEvent);
})();
