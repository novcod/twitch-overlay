/* twitch-overlay.js - Simple http server to serve overlays */

/* To add overlay:
    let video = {
      name: 'hpcwins',
      type: 'video',
      file: 'videos/events/hpcwins.mp4'
    }
    bot.overlays.add(video)
    // -OR-
    events.emit('overlays:add', video)*/

const express = require('express')
const Events = require('events')
const path = require('path')
const extend = require('extend')
const shortid = require('shortid') // Generate short unique identifiers

const types = {
  text: require('./types/text.js'),
  video: require('./types/video.js'),
  html: require('./types/html.js'),
  audio: require('./types/audio.js')
}

let app
let io
let self

let overlays = []  // List of overlays that have been loaded
let clients = {}   // List of clients that are connected (for cleaning events)

let state = {
  overlays: []
}     // Persistent state for the app


module.exports = class TwitchOverlay {
  constructor(_options) {

    // config letiables w/ default values
    this.options = {
        hostname: 'localhost',                      // Binds server to this host (optional)
        port: 3000,                                 // Binds server to this port
        directory: '/',                             // URL you want to point OBS/Xsplit at (optional, default: '/')
        viewEngine: 'pug',                          // Templating system you'd like to use (Express-compatible) (optional: defaults to pug) */
        events: new Events.EventEmitter()           // Listens to events to trigger overlays
    }

    const self = this // HACK for eventemitter listener scope

    // this.options for starting the overlay server:
    this.options = extend(this.options, _options)    // Copy _this.options into this.options, overwriting defaults

    app = express()    // Express should be accessible from all functions
    /* Start webapp */
    app.use(express.static(path.join(__dirname, 'static')))
    app.set('views', path.join(__dirname, 'views'))
    app.locals.basedir = app.get('views')
    app.set('view engine', this.options.viewEngine)

    app.get(this.options.directory, function (req, res, next) {
      try {
        res.render('index')
      } catch (e) {
        next(e)
      }
    })

    this.options.events.on('overlays:add', (overlays) => {
      this.add(overlays)
    })

    // Start server
    const server = require('http').Server(app)
    const port = this.options.port
    server.listen(port)
    console.log('[Overlay Server] listening on port ' + port)

    // Start Socket IO (event handler)
    io = require('socket.io')(server)

    io.on('connection', (socket) => {
        clients[socket.id] = []

        socket.on('disconnect', () => {
          // Clean up Overlay listener events on disconnect or reload to prevent memory leak
          this.unload(socket.id)
        })

        socket.on('endOverlay', (id, name, payload) => {
          this.end(id, name, payload)
        })

        this.update() // send latest state down to the client
    })

    /* Create initial state when server starts */
    this.update()
  }

  add(_overlays) {
    // Add overlay(s) to display them on stream.
    // Expects an Object or array of Objects w/ the following structure:
    //    name: 'powermove',            // String that will activate this in chat/events i.e. !powermove and powermove:show
    //    type: 'text',                 // (text, video, html)
    //    file: '../blah.mp4'           // (optional) Filename for video w/ path
    //    text: 'Blah has subscribed!'  // (optional) Text to display/read
    //    static: '../static/blah'      // (optional) directory containing images, etc to serve via webserver
    //    view:   '../test.pug'         // (optional) pug template to inject instead of the default

    let queue = [] // Overlays to be processed

    if(Array.isArray(_overlays)) {
      // Process multiple overlays
      queue = _overlays
    } else {
      queue.push(_overlays)
    }

    // Loop through each overlay and load it into our overlays array
    queue.forEach((item) => {
      let overlay
      let template

      switch(item.type) {
        case 'text':
          overlay = new types.text()
          break
        case 'video':
          overlay = new types.video(item.name, item.file, item.volume)
          break
        case 'html':
          overlay = new types.html(item.name, item.view, item.static)
          break
        case 'audio':
          overlay = new types.audio(item.name, item.directory)
          break
      }

      overlay.type = item.type    // Pass template down to client
      if(item.layout) {
        overlay.layout = item.layout
      } else {
        overlay.layout = 'center'
      }


      overlays.push(overlay)      // Keep track of all of the overlays

      if(overlay.directory) {
        // Add static assets (images, audio, etc) to server
        app.use('/' + overlay.name, express.static(overlay.directory))
      }

      this.options.events.on('overlay:' + overlay.name + ':show', (payload) => {
        this.show(overlay, payload)
      })

      this.options.events.on('overlay:' + overlay.name + ':hide', () => {
        this.hide(overlay.name)
      })
    })
  }

  update() {
    // Called any time we update the state on the server

    // Transform state to filter by layout
    let _state = {
      overlays: {
        fullscreen: state.overlays.filter(overlay => overlay.layout == 'fullscreen'),
        center: state.overlays.filter(overlay => overlay.layout == 'center'),
        right: state.overlays.filter(overlay => overlay.layout == 'right'),
        left: state.overlays.filter(overlay => overlay.layout == 'left')
      }
    }
    io.sockets.emit('overlays:state', _state)  // Send an update to all connected clients
  }

  show(overlay, payload) {
    let _overlay = {
      id: shortid.generate(),
      name: overlay.name,
      type: overlay.type,
      payload: overlay.payload,
      layout: 'center'
    }

    if(payload) {
      _overlay.payload = payload
    }

    _overlay = extend(_overlay, overlay)

    // Set overlay to 'showing'
    state.overlays.push(_overlay)

    this.update()
  }

  hide(name) {
    /* hide - Hides an overlay by name
       input: 'overlayName'
       output: n/a
    */
    if(name) {
      // Ignore empty requests
      for(let i = 0; i < state.overlays.length; i++) {
        console.log(state.overlays)
        if(state.overlays[i].name == name) {
          state.overlays.splice(i, 1)
        }
      }

      this.update()
    }
  }

  end(id, name, payload) {
    // Overlay ended, remove it from visible state
    state.overlays.forEach((overlay, index) => {
      if(overlay.id == id) {
        state.overlays.splice(index, 1)
        this.update()
      } else if (overlay.name == name) {
        state.overlays.splice(index, 1)

        // Trigger custom event
        this.options.events.emit('overlays:' + name + ':end', payload)
        this.update()
      }
    })
  }

  unload(socketId) {
    // remove listeners for each overlay event to prevent them sticking around
    for (let key in clients[socketId]) {
      this.options.events.removeListener(key, clients[socketId][key])
    }

    // Delete item from client object so it doesn't show up any more
    delete clients[socketId]

    if(Object.keys(clients).length === 0 && clients.constructor === Object) {
      overlays = []  // Empty the overlays queue if no clients are connected
    }
  }

  getState() {
    return(state.overlays)
  }

  clearState() {
    state.overlays = []
  }

  list() {
    // Returns the currently loaded overlays
    return(overlays)
  }

  clear() {
    overlays = []
  }
}
