// A tiny broadcast hub. Every SSE client (dashboard tabs, screens) subscribes
// here; whenever content/playlists/screens change, we broadcast a small
// { resource, action, id } message and let clients decide what to refetch.

const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(0); // an unbounded number of screens/tabs may connect

function broadcast(resource, action, id) {
  bus.emit("change", { resource, action, id, at: Date.now() });
}

function subscribe(listener) {
  bus.on("change", listener);
  return () => bus.off("change", listener);
}

module.exports = { broadcast, subscribe };
