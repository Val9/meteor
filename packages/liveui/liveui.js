Meteor.ui = Meteor.ui || {};

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

  var renderFragment = function(html_func, withEvents) {

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

    _.each(liveChunks, function(chunk) {
      chunk._send("added"); // first message in chunk's queue!
      if (withEvents)
        wireEvents(chunk);
    });

    return frag;
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

    return renderChunk(makeChunk(html_func, options));
  };

  var renderChunk = function(chunk) {
    var frag = renderFragment(function() {
      var html = chunk._init();
      return html;
    }, true);
    chunk._send("render");
    return frag;
  };

  var makeChunk = function(html_func, options) {
    options = _.extend({
      onupdate: function() {
        var self = this;
        var frag = renderFragment(function() {
          return html_func.call(self, self.data());
        });
        Meteor.ui._intelligent_replace(self.range, frag);
        self._send("render");
      },
      oninit: function() {
        return html_func.call(this, this.data());
      }
    }, options);

    return new Chunk(options);
  };

  Meteor.ui.chunk = function(html_func, options) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.chunk() requires a function as its first argument.");

    return makeChunk(html_func, options)._init();
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

    var makeDocChunk = function(doc) {
      var chunk = makeChunk(
        doc_func, {data: function() { return this.doc; }});
      chunk.doc = doc;
      return chunk;
    };

    var makeElseChunk = function() {
      return makeChunk(else_func);
    };

    var docChunks = [];
    var elseChunk = makeElseChunk();
    var outerChunk = null;

    var queuedUpdates = [];
    var enqueue = function(f) {
      queuedUpdates.push(f);
      outerChunk && outerChunk.update();
    };
    var runQueuedUpdates = function() {
      _.each(queuedUpdates, function(qu) { qu(); });
      queuedUpdates.length = 0;
    };

    var insertFrag = function(frag, i) {
      if (i === docChunks.length)
        docChunks[i-1].range.insert_after(frag);
      else
        docChunks[i].range.insert_before(frag);
    };

    var handle = observable.observe({
      added: function(doc, before_idx) {
        enqueue(function() {
          var addedChunk = makeDocChunk(doc);

          if (outerChunk) {
            console.log(doc);
            debugger;
            var frag = renderChunk(addedChunk);
            if (elseChunk)
              // else case -> one item
              outerChunk.range.replace_contents(frag);
            else
              insertFrag(frag, before_idx);
          }

          elseChunk && elseChunk.kill();
          elseChunk = null;
          docChunks.splice(before_idx, 0, addedChunk);
        });
      },
      removed: function(doc, at_idx) {
        enqueue(function() {
          if (outerChunk) {
            if (docChunks.length === 1) {
              // one item -> else case
              elseChunk = makeElseChunk();
              var frag = renderChunk(elseChunk);
              outerChunk.range.replace_contents(frag);
            } else {
              // remove item
              var removedChunk = docChunks[at_idx];
              removedChunk.range.extract();
            }
          }

          docChunks.splice(at_idx, 1)[0].kill();
        });
      },
      moved: function(doc, old_idx, new_idx) {
        enqueue(function() {
          if (old_idx === new_idx)
            return;

          var movedChunk = docChunks[old_idx];
          var frag;
          if (outerChunk) {
            // We know the list has at least two items,
            // at old_idx and new_idx, so `extract` will
            // succeed.
            var frag = movedChunk.range.extract();
            // remove chunk from list at old index
          }
          docChunks.splice(old_idx, 1);

          if (outerChunk)
            insertFrag(frag, new_idx);

          // insert chunk into list at new index
          docChunks.splice(new_idx, 0, movedChunk);
        });
      },
      changed: function(doc, at_idx) {
        enqueue(function() {
          var chunk = docChunks[at_idx];
          chunk.doc = doc;
          if (outerChunk)
            chunk.update();
        });
      }
    });

    runQueuedUpdates();

    options = options || {};

    options.onupdate = function() {
      // override the normal behavior (of recalculating
      // and smart-patching the whole contents of the chunk)
      runQueuedUpdates();
    };

    options.onkill = function() {
      handle.stop();
    };

    return Meteor.ui.chunk(function() {
      outerChunk = this;

      return _.map(
        (elseChunk ? [elseChunk] : docChunks),
        function(ch) { return ch._init(); }).join('');

    }, options);

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
        // wrap the frag in a new LiveRange that will be destroyed
        cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, frag));
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

    tgtRange.operate(function(start, end) {
      // clear all LiveRanges on target
      cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, start, end));

      var patcher = new Meteor.ui._Patcher(
        start.parentNode, srcParent,
        start.previousSibling, end.nextSibling);
      patcher.diffpatch(copyFunc);
    });
  };

  var wireEvents = function(chunk, andEnclosing) {
    // Attach events to top-level nodes in `chunk` as specified
    // by its event handlers.
    //
    // If `andEnclosing` is true, we also walk up the chunk
    // hierarchy looking for event types we need to handle
    // based on handlers in ancestor chunks.  This is necessary
    // when a chunk is updated or a rendered fragment is added
    // to the DOM -- basically, when a chunk acquires ancestors.
    //
    // In modern browsers (all except IE <= 8), this level of
    // subtlety is not actually required, because the implementation
    // of Meteor.ui._event.registerEventType binds one handler
    // per type globally on the document.  However, the Old IE impl
    // takes advantage of it.

    var range = chunk.range;

    for(var c = chunk; c; c = c.parentChunk()) {
      var handlers = c.event_handlers;

      if (handlers) {
        _.each(handlers.types, function(t) {
          for(var n = range.firstNode(), after = range.lastNode().nextSibling;
              n && n !== after;
              n = n.nextSibling)
            Meteor.ui._event.registerEventType(t, n);
        });
      }

      if (! andEnclosing)
        break;
    }
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

      if (options.onupdate)
        self.onupdate = options.onupdate;
      if (options.onadded)
        self.onadded = options.onadded;
      if (options.onkill)
        self.onkill = options.onkill;
      if (options.oninit)
        self.oninit = options.oninit;
    }

    // make self.data() a function if it isn't
    if (typeof self.data !== "function") {
      var constantData = self.data;
      self.data = function() { return constantData; };
    }

    // Allow Meteor.deps to signal us about a data change by
    // invalidating self._context.  By the time we see the
    // invalidation, it's flush time.  We immediately set up
    // a new context for next time.
    // Always having the latest context in an instance variable
    // makes clean-up easier.
    var ondirty = function() {
      self._send("update");
      self._context = new Meteor.deps.Context;
      self._context.on_invalidate(ondirty);
    };
    self._context = new Meteor.deps.Context;
    self._context.on_invalidate(ondirty);
  };

  Chunk.prototype._init = function() {
    var self = this;

    var html = self._context.run(function() {
      return self.oninit();
    });

    if (typeof html !== "string")
      throw new Error("Render function must return a string");

    var render_mode = Meteor.ui._render_mode;

    if (! render_mode) {
      // no reactivity possible, so kill the chunk (on next flush)
      self.kill();
      return html;
    }

    var commentId = render_mode.nextId ++;
    render_mode.idToChunk[commentId] = self;

    return "<!-- STARTRANGE_"+commentId+" -->" + html +
      "<!-- ENDRANGE_"+commentId+" -->";
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
        // Pronounce this chunk dead.  We rely on this finalization to clean
        // up the deps context, which is first created in the constructor.
        // There are many ways for a chunk to die -- never rendered, never
        // added to the DOM, removed as part of an update, removed
        // surreptitiously -- but all roads lead here.
        self.killed = true;
        self._context.invalidate();
        self._context = null;
        self.onkill();
      } else if (msg === "added") {
        // This chunk is part of the document for the first time.
        wireEvents(self);
        self.onadded();
      } else if (msg === "update") {
        // Rerender this chunk in place, in whole or in part.
        self._context.run(function() {
          self.onupdate();
        });
      } else if (msg === "render") {
        // This chunk is the root of a Meteor.ui.render or a reactive
        // update.  Its descendent nodes are (most likely) new to the
        // document.
        wireEvents(self, true);
      }
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
    // schedule killing for flush time.
    if (! this.killed)
      this._send("kill");
  };

  Chunk.prototype.update = function() {
    // invalidate the context, as if a data dependency changed.
    // we'll get an "update" message at flush time.
    this._context.invalidate();
  };

  // default callbacks to be overriden
  Chunk.prototype.oninit = function() { return ""; };
  Chunk.prototype.onupdate = function() {};
  Chunk.prototype.onkill = function() {};
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

  // Cleans up a range and its descendant ranges by killing
  // any attached chunks (which removes the associated contexts
  // from dependency tracking) and then destroying the LiveRanges
  // (which removes the liverange data from the DOM).
  var cleanup_range = function(range) {
    range.visit(function(is_start, range) {
      if (is_start)
        range.chunk && range.chunk.kill();
    });
    range.destroy(true);
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
