# Embuscade

This is a simple tank shooter in a maze game, with powerups.  In addition, it
includes a lobby system that allows players to chat and create games, optionally
private games.  When creating games, it's possible to choose the number of human
and AI opponents, the size of the maze, and victory conditions.

Scoring is the rudimentary count of other tanks destroyed.

The interesting feature of the game is its online-in-the-browser nature.  We
typically don't see gRPC or websockets at work.  Browser games are rare because
they're hard to monetise and working in the browser with its incessant security
focus can make it challenging.  And frankly, web 2.0 was a website slop era.
Websites crammed in all the advertising they could and rushed to market as
quickly as possible.  There's no room for interesting in that world.

# Client

The client is a vanilla js app meant to be plugged in to the
[widgetGrid](https://github.com/Pie-Laboratories-LLC/widgetgrid) website.
It also runs standalone - see [running](#Running) below.

The client establishes a websocket connection to the server.

# Server

The server is a vanilla js app meant which runs in EKS.  It's built with the
provided Dockerfile.  It also runs standalone - see [running](#Running) below.

The server hosts websocket connections from clients.  Currently, there is one
server.  For a simple website not easily accessible via SEO or agents, this
suffices for now.

# Running

```bash
# client
$ npm run dev --workspace=@bolo/client
# server
npm run start --workspace=@bolo/server
```

# AI

This is mostly the work of Anthropic Claude over the course of a couple days
where I made the design decisions and lightly edited the code.

