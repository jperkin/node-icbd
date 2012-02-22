## What?

ICB daemon in node.js.

Oh, you mean what is ICB?  It's a really old, quirky chat system vaguely
similar to IRC, and for unfathomable reasons is still used by a number of open
source projects, not at all similar to that old worn out but still comfortable
pair of slippers we all wear, oh no :)

The ICB protocol is documented
[here](http://www.icb.net/_jrudd/icb/protocol.html), however it only describes
basic functionality.  There are many additional features and commands provided
by at least
[i2cb](ftp://ftp.netbsd.org/pub/pkgsrc/current/pkgsrc/chat/i2cb/README.html)
which should be supported in any reasonable implementation.

This server attempts to emulate i2cb, down to the same message strings etc.

## Why?

Fun!  Also I maintain [irssi-icb](https://github.com/jperkin/irssi-icb) so this
is a good way to learn ICB from the server point-of-view, and has already
exposed a number of bugs in my plugin.

Also,
[i2cb](ftp://ftp.netbsd.org/pub/pkgsrc/current/pkgsrc/chat/i2cb/README.html)
isn't very portable, so this may be of benefit to anyone who wants to run an
icb server on something other than \*BSD

## Current status?

### Supported

Group and private chats.
Moderators (but they are currently powerless, it's nothing more than a badge).
Most basic commands (/nick, /join, /brick etc).

### Unsupported

Nickname registration and server commands.
Moderation commands.
Administration commands.
Miscellaneous user commands (beep, exclude, invite, etc).
Probably lots more dusty corners of ICB I've never even heard of..

## Future work?

It would be better to make this a proper library, split out the server, and
allow clients to be written easily.

An HTTP interface would be useful too.
