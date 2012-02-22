#!/usr/bin/node

/*
 * Some quirks of ICB, for those used to IRC.
 *
 *  - A user is in exactly one group at all times.
 *  - Groups have one (more?) moderator, who can part/join and retain status,
 *    but if they disconnect then mod passes to eldest in the group by login
 *    time.
 *  - /brick ;-)
 *  - Nicknames can have special characters (e.g. '@', and '!'), groups do not
 *    have to start with '#' (and usually don't).
 *
 * Currently supported:
 *
 *  - Basic groups, people can join and chat with each other
 *  - Group topics and moderators, though moderators have no power
 *  - /brick :)
 *  - /nick, /join, mostly functional /who
 *  - Private messages
 *
 * TODO next:
 *
 *  - Persistent user accounts, and associated commands
 *  - Admin + commands (drop, shutdown, wall)
 *  - Moderator commands (talk, topic, cancel, boot)
 *  - Misc commands (invite, v, hush, nobeep, shuttime, notify,
 *                   exclude, news, {no,}away, whereis, others?)
 *
 * TODO later:
 * 
 *  - Support "w" logins (just dump /who and quit)
 *  - Lots more..
 */

 /*
  * Notes on moderation:
  *
  *  - When a group is created, the moderator is the group creator.
  *
  *  - If that person joins a different group, they remain moderator
  *    of the original group (and can hold moderation of the group they
  *    joined), and can re-join the original group as moderator.
  *
  *  - If the original moderator quits, moderation passes to the user
  *    who has been online the longest (not necessarily the person who
  *    has been in the group the longest).
  *
  *  - A moderator can choose to /pass moderation, either to a named
  *    user (who doesn't necessarily need to be in the group at the time,
  *    just online), or to nobody, in which case the group is left with
  *    no moderator.
  */

/* Extra console logging */
var debug = 1;

function logdebug(message) {
  if (debug) {
    console.log(message);
  }
}

var fs = require("fs");
var net = require("net");
var os = require("os");
var path = require("path");

/*
 * The main global ICB session.
 */
var session = {
  "sockets": [],
  "groups": {
    // group: {
    //   topic: "A topic",
    //   mod: socket_of_mod,
    // },
  },
};

/*
 * Parse ICB message into [cmd, arg, ...]
 */
function parseicbmsg(msg) {
  msg = msg.replace(/\000/g, "");
  msg = msg.replace(/\s*$/g, "");
  logdebug("=<=" + msg.slice(1).replace(/\001/g, "^A") + "=<");
  var cmd = msg.slice(1,2);
  var args = msg.slice(2).split("\001");
  return [cmd, args];
}

var server = net.createServer(function (socket) {

  /*
   * While I'm almost certain many ICB clients/servers are not 8 bit clean, we
   * do need to use UTF-8 encoding to stop NULs coming through as spaces...
   */
  socket.setEncoding("utf8");

  /*
   * New connection, send "jProtoLevel, HostID, ServerID"
   */
  socket.on("connect", function (data) {
    session["sockets"].push(socket);
    send_client_msg(socket, ["j1", os.hostname(), "icbd.js 0.1beta"]);
  });

  /*
   * Parse ICB message
   */
  socket.on("data", function (data) {
    var msg = parseicbmsg(data);
    var cmd = msg[0];
    var args = msg[1];

    // aLoginid^ANickname^ADefaultGroup^ACommand^APassword[^AGroupStatus][^AProtocolLevel]
    if (cmd == "a") {
      var loginid = args[0];
      var nickname = args[1];
      var defgroup = args[2];
      var logincmd = args[3]; // TODO: assumes 'login' for now, support 'w' later
      var password = args[4]; // TODO: support persistent user auth
      if (args.length > 5) {
        var groupstat = args[5];
      }
      if (args.length > 6) {
        // TODO: ProtocolLevel ignored (deprecated)
      }

      /* Ensure nickname is available */
      if (get_nick_socket(nickname)) {
          /* i2cbd doesn't close the connection, but we do */
          send_client_msg(socket, "eNickname already in use.");
          send_client_msg(socket, "g");
          socket.end();
          return;
      }

      if (nickname.length == 0 || nickname.length > 12) {
          send_client_msg(socket, "eNickname must be between 1 and 12 characters.");
          send_client_msg(socket, "g");
          socket.end();
          return;
      }

      /* Send welcome */
      send_client_msg(socket, "a");
      print_motd(socket);

      socket.nickname = nickname;
      socket.idlesince = parseInt(new Date().getTime() / 1000);
      socket.logintime = parseInt(new Date().getTime() / 1000);
      socket.username = loginid;
      socket.hostname = socket.remoteAddress;
      socket.bricks = 5;

      if (defgroup) {
        if (!session["groups"].hasOwnProperty(defgroup)) {
          session["groups"][defgroup] = {"topic": "(None)", "mod": socket};
        }
        socket.group = defgroup;

        // XXX: restricted groups?
        var asmod = (socket == session["groups"][defgroup]["mod"]) ? " as moderator" : "";
        send_client_msg(socket, ["dStatus", "You are now in group " + defgroup + asmod]);
        send_group_msg(defgroup, ["dSign-on", socket.nickname + " (" + socket.username + "@" + socket.hostname + ") entered group"]);
      }
    }

    // bMessageText
    if (cmd == "b") {
      socket.idlesince = parseInt(new Date().getTime() / 1000);
      if (num_users_in_group(socket.group) > 1) {
        send_group_msg(socket.group, ["b" + socket.nickname, args[0]]);
      } else {
        send_client_msg(socket, ["eNo one else in group!"]);
      }
    }

    /*
     * Generic client-to-server command
     *
     * hCommand[^AArguments][^AMessageID]
     *
     */
    if (cmd == "h") {
      switch (args[0]) {
      case 'beep':
        if (!args[1]) {
          break;
        }
        var target = args[1];
        var tsock = get_nick_socket(target);
        if (!tsock) {
          send_client_msg(socket, ["e" + target + " not signed on."]);
          break;
        }
        send_client_msg(tsock, ["k" + socket.nickname]);
        break;
      /*
       * The most important command! :)
       *
       * I believe proper ICB allows cross-group bricks, but not sure, for now
       * I restrict to in-group bricking..
       *
       * TODO: support brick floods (get kicked out for over-bricking).
       */
      case 'brick':
        if (!args[1]) {
          send_client_msg(socket, ["dMessage", "You have " +
                                   ((socket.bricks) ? socket.bricks : "no") +
                                   ((socket.bricks == 1) ? " brick" : " bricks") +
                                   " remaining."]);
          break;
        }
        if (socket.bricks == 0) {
          send_client_msg(socket, ["eYou are out of bricks."]);
          break;
        }
        var target = args[1];
        if (nick_in_group(target, socket.group) && target != socket.nickname) {
          var tsock = get_nick_socket(target);
          tsock.bricks += 1;
          send_group_msg_all(socket.group, ["dFYI", target + " has been bricked."]);
        } else {
          send_group_msg_all(socket.group, ["dFYI", "A brick flies off into the ether."]);
        }
        socket.bricks -= 1;
        break;
      /*
       * Change group (/join)
       */
      case 'g':
        if (!args[1]) {
          break;
        }
        var group = args[1];
        /*
         * i2cbd seems to have a 7 character limit on group names, but will
         * happily truncate longer requests.  Let's not do that.
         *
         * Unfortunately, irssi-icb will join the requested channel regardless,
         * something I should probably fix at some point :)
         */
        if (group.length > 7) {
          send_client_msg(socket, "eGroup name too long (max 7).");
          break
        }
        if (!session["groups"].hasOwnProperty(group)) {
          session["groups"][group] = {"topic": "(None)", "mod": socket};
        }
        var oldgroup = socket.group
        socket.group = group;
        if (num_users_in_group(oldgroup) > 0) {
          send_group_msg(oldgroup, ["dDepart", socket.nickname + " (" + socket.username + "@" + socket.hostname + ") just left"]);
        } else {
          delete session["groups"][oldgroup];
        }
        var asmod = (socket == session["groups"][group]["mod"]) ? " as moderator" : "";
        send_client_msg(socket, ["dStatus", "You are now in group " + group + asmod]);
        send_group_msg(group, ["dSign-on", socket.nickname + " (" + socket.username + "@" + socket.hostname + ") entered group"]);
        if (session["groups"][oldgroup] &&
            socket == session["groups"][oldgroup]["mod"]) {
          send_client_msg(socket, ["fMod", "You are still mod of group " + oldgroup]);
        }
        break;
      /*
       * Private message
       */
      case 'm':
        if (!args[1]) {
          break;
        }
        var parts = args[1].split(" ");
        var nick = parts.slice(0,1);
        var msg = parts.slice(1);
        var sock = get_nick_socket(nick);
        if (sock) {
          send_client_msg(sock, ["c" + socket.nickname, msg]);
        } else {
          send_client_msg(socket, ["e" + nick + " not signed on."])
        }
        break;
      /*
       * Message Of The Day
       */
      case 'motd':
        print_motd(socket);
        break;
      /*
       * /nick aka name
       */
      case 'name':
        if (!args[1]) {
          send_client_msg(socket, "eThe nickname may not be null.");
          break;
        }
        var nick = args[1];
        if (nick.length == 0 || nick.length > 12) {
          send_client_msg(socket, "eNickname must be between 1 and 12 characters.");
          break;
        }
        if (!get_nick_socket(nick)) {
          var oldnick = socket.nickname;
          socket.nickname = nick;
          send_group_msg_all(socket.group, ["dName", oldnick + " changed nickname to " + nick]);
        } else {
          send_client_msg(socket, "eNickname already in use.");
        }
        break;
      /*
       * /pass moderation, optionally to another user (who does not
       * necessarily have to be in the group at the time, just online).
       */
      case 'pass':
        var passto = args[1];
        if (session["groups"][socket.group]["mod"] === socket) {
          if (passto) {
            var pass_sock = get_nick_socket(passto);
            if (pass_sock) {
              session["groups"][socket.group]["mod"] = pass_sock;
              send_group_msg_all(socket.group, ["dPass", socket.nickname + " has passed moderation to " + passto]);
            } else {
              send_client_msg(socket, "e" + passto + " is not on!");
            }
          } else {
            session["groups"][socket.group]["mod"] = {};
            send_group_msg_all(socket.group, ["dPass", socket.nickname + " just relinquished the mod."]);
          }
        } else {
          send_client_msg(socket, "eYou aren't the moderator.");
        }
        break;
      /*
       * Currently there are no restrictions on who can set the topic
       */
      case 'topic':
        if (!args[1]) {
          break;
        }
        var topic = args[1]
        session["groups"][socket.group]["topic"] = topic;
        send_group_msg_all(socket.group, ["dTopic", socket.nickname + " changed the topic to \"" + topic + "\""]);
        break;
      /*
       * Group flags "vl" are currently faked-up..
       */
      case 'w':
        var numgroups = 0;
        send_client_msg(socket, ["ico", ""]);
        for (var group in session["groups"]) {
          numgroups += 1;
          // Should really just pull in *printf...
          var grouppad = "  "; 
          for (var i = 7; i > group.length; i--) {
            grouppad += " ";
          }
          var modflag = (session["groups"][group]["mod"].nickname) ? "m" : "p";
          var mod = session["groups"][group]["mod"].nickname || "(None)";
          var modpad = "  ";
          for (var i = 12; i > mod.length; i--) {
            modpad += " ";
          }
          send_client_msg(socket, ["ico",
                                   "Group: " + group + grouppad +
                                   "(" + modflag + "vl) Mod: " + mod + modpad +
                                   "Topic: " + session["groups"][group]["topic"]]);
          session["sockets"].forEach(function (sock) {
            if (sock.group == group) {
              var groupmod = (session["groups"][group]["mod"].nickname === sock.nickname) ? "*" : " ";
              send_client_msg(socket, ["iwl", groupmod, sock.nickname, parseInt(parseInt(new Date().getTime() / 1000) - sock.idlesince), "0", sock.logintime, sock.username, sock.hostname, "(nr)"]);
            }
          });
        }
        var numusers = total_users();
        var pluraluser = (numusers == 1) ? "" : "s";
        var pluralgroup = (numgroups == 1) ? "" : "s";
        send_client_msg(socket, ["ico", "Total: " + numusers + " user" + pluraluser + " in " + numgroups + " group" + pluralgroup]);
        break;
      default:
        console.log("Unsupported client command " + args[0]);
        break;
      }
    }
  });

  /*
   * ICB doesn't have any quit commands, so we trigger user cleanup on
   * the socket closing.
   */
  socket.on("end", function (data) {
    if (num_users_in_group(socket.group) > 1) {
      send_group_msg(socket.group, ["dSign-off", socket.nickname + " (" + socket.username + "@" + socket.hostname + ") has signed off."]);
    } else {
      delete session["groups"][socket.group];
    }
    /*
     * Pass moderation of group to user with oldest login time
     */
    for (var group in session["groups"]) {
      var passto = undefined;
      if (socket == session["groups"][group]["mod"]) {
        session["sockets"].forEach(function (sock) {
          if (sock != socket && 
              sock.group == group &&
              (!passto || (passto && passto.logintime > sock.logintime))) {
            logdebug("assign!");
            passto = sock;
          }
        }, passto);
        if (group != socket.group) {
          send_group_msg(group, ["dSign-off", "Your group moderator signed off."]);
        }
        session["groups"][group]["mod"] = passto;
        send_group_msg(group, ["dPass", passto.nickname + " is now mod."]);
      }
    }
    // taken from https://gist.github.com/707146
    session["sockets"].splice(session["sockets"].indexOf(socket), 1);
  });

  /*
   * Get a nickname's socket.  Returns undefined if unavailable, so is used
   * to check availability.
   */
  function get_nick_socket(nickname) {
    var nicksock;
    session["sockets"].forEach(function (sock) {
      if (sock.nickname && nickname == sock.nickname) {
        nicksock = sock;
      }
    }, nicksock);
    return nicksock;
  }

  /*
   * Check nickname is in current group
   */
  function nick_in_group(nickname, group) {
    var present = 0;
    session["sockets"].forEach(function (sock) {
      if (sock.nickname && nickname == sock.nickname &&
          sock.group && group == sock.group) {
        present = 1;
      }
    }, present);
    return present;
  }

  /*
   * Send a message to a client
   */
  function send_client_msg(sock, message) {
    if (typeof message === 'object') {
      var msg = message.join("\001")
    } else {
      var msg = message;
    }
    logdebug("=>=" + msg.replace(/\001/g, "^A") + "=>=")
    // Prepend length of string as single byte
    msg = String.fromCharCode(msg.length) + msg;
    sock.write(msg);
  }

  /*
   * Send a message to a group, excluding origin
   */
  function send_group_msg(group, message) {
    session["sockets"].forEach(function (sock) {
      if (sock.group === group &&
          sock !== socket) {
        send_client_msg(sock, message);
      }
    });
  }
  /*
   * Send a message to a group, including origin (e.g. /topic)
   */
  function send_group_msg_all(group, message) {
    session["sockets"].forEach(function (sock) {
      if (sock.group === group) {
        send_client_msg(sock, message);
      }
    });
  }
  /*
   * Total number of users.  We check for a nickname to ensure it's a
   * completed connection.
   */
  function total_users() {
    var count = 0;
    session["sockets"].forEach(function (sock) {
      if (sock.nickname) {
        count += 1;
      }
    }, count);
    return count;
  }
  /*
   * Count number of users in a group
   */
  function num_users_in_group(group) {
    var count = 0;
    session["sockets"].forEach(function (sock) {
      if (sock.group === group) {
        count += 1;
      }
    }, count);
    return count;
  }
  /*
   * Display MOTD, if available.  Currently synchronous.
   */
  function print_motd(socket) {
    if (path.existsSync('motd.txt')) {
      var motd = fs.readFileSync('motd.txt', 'ascii');
      motd.split("\n").slice(0,-1).forEach(function(line) {
       send_client_msg(socket, ["ico", line]);
      });
    }
  }
});

server.listen("7326");
