#!/usr/bin/node

/*
 * Really dumb ICB client, currently just used for testing.
 */
var net = require('net');

var client = function() {
  var socket = net.createConnection(7326, process.ARGV[2]);

  socket.setEncoding("utf8");

  socket.on('connect', function(connect) {
    sendicbmsg("ajperkin\001jperkin@js\001test\001login");
  });

  socket.on('data', function(data) {
    data.split("\0").forEach(function(line) {
      console.log(line.replace(/\001/g, "^A").slice(1));
    });
  });

  function sendicbmsg(message) {
    socket.write(String.fromCharCode(message.length) + message);
  }
}

if (!process.ARGV[2]) {
  console.log("usage: icb.js <server>");
  process.exit(2);
}
client();
