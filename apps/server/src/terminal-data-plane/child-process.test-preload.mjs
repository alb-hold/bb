import net from "node:net";

const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function reportNetworkListen(...args) {
  const target = args[0];
  const isPipe =
    typeof target === "string" ||
    (typeof target === "object" &&
      target !== null &&
      typeof target.path === "string");
  if (!isPipe) {
    process.send?.({ type: "test.network-listen" });
  }
  return listen.apply(this, args);
};
