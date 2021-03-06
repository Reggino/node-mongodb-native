var ReadPreference = require('./read_preference').ReadPreference
  , Base = require('./base').Base
  , Server = require('./server').Server
  , inherits = require('util').inherits;

/**
 * Mongos constructor provides a connection to a mongos proxy including failover to additional servers
 *
 * Options
 *  - **socketOptions** {Object, default:null}, an object containing socket options to use (noDelay:(boolean), keepAlive:(number), connectTimeoutMS:(number), socketTimeoutMS:(number))
 *  - **ha** {Boolean, default:true}, turn on high availability, attempts to reconnect to down proxies
 *  - **haInterval** {Number, default:2000}, time between each replicaset status check.
 *
 * @class Represents a Mongos connection with failover to backup proxies
 * @param {Array} list of mongos server objects
 * @param {Object} [options] additional options for the mongos connection
 */
var Mongos = function Mongos(servers, options) {
  // Set up basic
  if(!(this instanceof Mongos))
    return new Mongos(servers, options);

  // Set up event emitter
  Base.call(this);

  // Throw error on wrong setup
  if(servers == null || !Array.isArray(servers) || servers.length == 0)
    throw new Error("At least one mongos proxy must be in the array");

  // Ensure we have at least an empty options object
  this.options = options == null ? {} : options;
  // Set default connection pool options
  this.socketOptions = this.options.socketOptions != null ? this.options.socketOptions : {};
  // Enabled ha
  this.haEnabled = this.options['ha'] == null ? true : this.options['ha'];
  this._haInProgress = false;
  // How often are we checking for new servers in the replicaset
  this.mongosStatusCheckInterval = this.options['haInterval'] == null ? 1000 : this.options['haInterval'];
  // Save all the server connections
  this.servers = servers;
  // Servers we need to attempt reconnect with
  this.downServers = [];
  // Just contains the current lowest ping time and server
  this.lowestPingTimeServer = null;
  this.lowestPingTime = 0;

  // Connection timeout
  this._connectTimeoutMS = this.socketOptions.connectTimeoutMS
    ? this.socketOptions.connectTimeoutMS
    : 1000;

  // Add options to servers
  for(var i = 0; i < this.servers.length; i++) {
    var server = this.servers[i];
    server._callBackStore = this._callBackStore;
    // Default empty socket options object
    var socketOptions = {host: server.host, port: server.port};
    // If a socket option object exists clone it
    if(this.socketOptions != null) {
      var keys = Object.keys(this.socketOptions);
      for(var k = 0; k < keys.length;k++) socketOptions[keys[i]] = this.socketOptions[keys[i]];
    }

    // Set socket options
    server.socketOptions = socketOptions;
  }
}

/**
 * @ignore
 */
inherits(Mongos, Base);

/**
 * @ignore
 */
Mongos.prototype.isMongos = function() {
  return true;
}

/**
 * @ignore
 */
Mongos.prototype.connect = function(db, options, callback) {
  if('function' === typeof options) callback = options, options = {};
  if(options == null) options = {};
  if(!('function' === typeof callback)) callback = null;
  var self = this;

  // Keep reference to parent
  this.db = db;
  // Set server state to connecting
  this._serverState = 'connecting';
  // Number of total servers that need to initialized (known servers)
  this._numberOfServersLeftToInitialize = this.servers.length;  
  // Connect handler
  var connectHandler = function(_server) {
    return function(err, result) {
      self._numberOfServersLeftToInitialize = self._numberOfServersLeftToInitialize - 1;

      if(self._numberOfServersLeftToInitialize == 0) {
        // Start ha function if it exists
        if(self.haEnabled) {
          // Setup the ha process
          if(self._replicasetTimeoutId != null) clearInterval(self._replicasetTimeoutId);
          self._replicasetTimeoutId = setInterval(self.mongosCheckFunction, self.mongosStatusCheckInterval);
        }

        // Set the mongos to connected
        self._serverState = "connected";
        // Emit the open event
        self.db.emit("open", null, self.db);
        // Callback
        callback(null, self.db);
      }
    }
  };

  // Error handler
  var errorOrCloseHandler = function(_server) {
    return function(err, result) {
      var validServers = [];
      // Execute all the callbacks with errors
      self.__executeAllCallbacksWithError(err);
      
      // Save the down server
      self.downServers.push(_server);

      // Remove the current server from the list
      for(var i = 0; i < self.servers.length; i++) {
        if(!(self.servers[i].host == _server.host && self.servers[i].port == _server.port)) {
          validServers.push(self.servers[i]);
        }
      }

      // Set current list of servers
      self.servers = validServers;
    }
  }

  // Mongo function
  this.mongosCheckFunction = function() {
    if(self._haInProgress) return;
    // Set as not waiting for check event 
    self._haInProgress = true;
    // Check downed servers
    if(self.downServers.length > 0) {
      var numberOfServersLeft = self.downServers.length;

      // Iterate over all the downed servers
      for(var i = 0; i < self.downServers.length; i++) {
        // Pop a downed server      
        var downServer = self.downServers.pop();

        // Set up the connection options for a Mongos
        var options = {
          auto_reconnect: false,
          returnIsMasterResults: true,
          slaveOk: true,
          poolSize: downServer.poolSize,
          socketOptions: { 
            connectTimeoutMS: self._connectTimeoutMS,
            socketTimeoutMS: self._socketTimeoutMS
          }          
        }

        // Create a new server object
        var newServer = new Server(downServer.host, downServer.port, options);
        // Setup the connection function
        var connectFunction = function(_db, _server, _options)  {
          return function() {
            // Attempt to connect
            _server.connect(_db, _options, function(err, result) {
              numberOfServersLeft = numberOfServersLeft - 1;

              if(err) {
                self.downServers.push(_server);
              } else {
                // Set the new server settings
                _server._callBackStore = self._callBackStore;
                
                // Add server event handlers
                _server.on("close", errorOrCloseHandler(_server));
                _server.on("timeout", errorOrCloseHandler(_server));
                _server.on("error", errorOrCloseHandler(_server));
                
                // Add the server to the list of available servers
                self.servers.push(_server);

                // Get a read connection
                var _connection = _server.checkoutReader();
                // Get the start time
                var startTime = new Date().getTime();
                // Execute ping command to mark each server with the expected times
                self.db.command({ping:1}
                  , {failFast:true, connection:_connection}, function(err, result) {
                  // Get the start time
                  var endTime = new Date().getTime();
                  // Mark the server with the ping time
                  _server.runtimeStats['pingMs'] = endTime - startTime;
                  // Sort the servers on runtime so the first server always is the closest one
                  self.servers.sort(function(a, b) {
                    return a.runtimeStats['pingMs'] > b.runtimeStats['pingMs'];
                  });
                });
              }

              if(numberOfServersLeft == 0) {
                self._haInProgress = false;
              }
            });
          }
        } 

        // Attempt to connect to the database
        connectFunction(self.db, newServer, options)();
      }
    } else {
      self._haInProgress = false;
    }
  }


  //   console.log("========================================= mongos check function")
  //   // If we have down servers let's attempt a reconnect
  //   if(self.downServers.length > 0) {
  //     var numberOfServersLeft = self.downServers.length;
  //     // Attempt to reconnect
  //     for(var i = 0; i < self.downServers.length; i++) {
  //       var downServer = self.downServers.pop();
        
  //       // Configuration
  //       var options = {
  //         slaveOk: true,
  //         poolSize: 1,
  //         socketOptions: { connectTimeoutMS: self._connectTimeoutMS },
  //         returnIsMasterResults: true
  //       }        

  //       // Attemp to reconnect
  //       downServer.connect(self.db, options, function(_server) {
  //         // Return a function to check for the values
  //         return function(err, result) {
  //           console.log("========================================= mongos check function 0")
  //           // Adjust the number of servers left
  //           numberOfServersLeft = numberOfServersLeft - 1;

  //           if(err != null) {
  //             console.log("========================================= mongos check function 1")
  //             self.downServers.push(_server);
  //           } else {
  //             console.log("========================================= mongos check function 2")
  //             // Add server event handlers
  //             _server.on("close", errorOrCloseHandler(_server));
  //             _server.on("error", errorOrCloseHandler(_server));
  //             _server.on("timeout", errorOrCloseHandler(_server));
  //             // Add to list of servers
  //             self.servers.push(_server);
  //           }

  //           if(numberOfServersLeft <= 0) {
  //             // Perfom another ha
  //             self._replicasetTimeoutId = setTimeout(self.mongosCheckFunction, self.mongosStatusCheckInterval);
  //           }
  //         }
  //       }(downServer));
  //     }
  //   } else if(self.servers.length > 0) {
  //     var numberOfServersLeft = self.servers.length;
  //     var _s = new Date().getTime()

  //     // Else let's perform a ping command
  //     for(var i = 0; i < self.servers.length; i++) {
  //       var executePing = function(_server) {
  //         // Get a read connection
  //         var _connection = _server.checkoutReader();
  //         // Execute ping command
  //         self.db.command({ping:1}, {failFast:true, connection:_connection}, function(err, result) {
  //           var pingTime = new Date().getTime() - _s;
  //           // If no server set set the first one, otherwise check
  //           // the lowest ping time and assign the server if it's got a lower ping time
  //           if(self.lowestPingTimeServer == null) {
  //             self.lowestPingTimeServer = _server;
  //             self.lowestPingTime = pingTime;
  //             console.log("=========================================== ping 0")
  //             self._currentMongos = _server;
  //           } else if(self.lowestPingTime > pingTime
  //               && (_server.host != self.lowestPingTimeServer.host || _server.port != self.lowestPingTimeServer.port)) {
  //             self.lowestPingTimeServer = _server;
  //             self.lowestPingTime = pingTime;
  //             console.log("=========================================== ping 1")
  //             self._currentMongos = _server;
  //           }

  //           // Number of servers left
  //           numberOfServersLeft = numberOfServersLeft - 1;
  //           // All active mongos's pinged
  //           if(numberOfServersLeft == 0) {
  //             // Perfom another ha
  //             self._replicasetTimeoutId = setTimeout(self.mongosCheckFunction, self.mongosStatusCheckInterval);
  //           }
  //         })
  //       }
        
  //       // Execute the function
  //       executePing(self.servers[i]);
  //     }
  //   } else {
  //     self._replicasetTimeoutId = setTimeout(self.mongosCheckFunction, self.mongosStatusCheckInterval);
  //   }
  // }

  // Connect all the server instances
  for(var i = 0; i < this.servers.length; i++) {
    // Get the connection
    var server = this.servers[i];
    server.mongosInstance = this;
    // Add server event handlers
    server.on("close", errorOrCloseHandler(server));
    server.on("timeout", errorOrCloseHandler(server));
    server.on("error", errorOrCloseHandler(server));
    
    // Configuration
    var options = {
      slaveOk: true,
      poolSize: server.poolSize,
      socketOptions: { connectTimeoutMS: self._connectTimeoutMS },
      returnIsMasterResults: true
    }        

    // Connect the instance
    server.connect(self.db, options, connectHandler(server));
  }
}

/**
 * @ignore
 * Just return the currently picked active connection
 */
Mongos.prototype.allServerInstances = function() {
  return this.servers;
}

/**
 * Always ourselves
 * @ignore
 */
Mongos.prototype.setReadPreference = function() {}

/**
 * @ignore
 */
Mongos.prototype.allRawConnections = function() {
  // Neeed to build a complete list of all raw connections, start with master server
  var allConnections = [];
  // Add all connections
  for(var i = 0; i < this.servers.length; i++) {
    allConnections = allConnections.concat(this.servers[i].allRawConnections());
  }

  // Return all the conections
  return allConnections;
}

/**
 * @ignore
 */
Mongos.prototype.isConnected = function() {
  return this._serverState == "connected";
}

/**
 * @ignore
 */
Mongos.prototype.checkoutWriter = function() {
  if(this.servers.length == 0) return null;
  return this.servers[0].checkoutWriter();
}

/**
 * @ignore
 */
Mongos.prototype.checkoutReader = function(read) {
  // If we have a read preference object unpack it
  if(typeof read == 'object' && read['_type'] == 'ReadPreference') {
    // Validate if the object is using a valid mode
    if(!read.isValid()) throw new Error("Illegal readPreference mode specified, " + read.mode);
  } else if(!ReadPreference.isValid(read)) {
    throw new Error("Illegal readPreference mode specified, " + read);
  }

  if(this.servers.length == 0) return null;
  return this.servers[0].checkoutWriter();
}

/**
 * @ignore
 */
Mongos.prototype.close = function(callback) {
  var self = this;
  // Set server status as disconnected
  this._serverState = 'disconnected';
  // Number of connections to close
  var numberOfConnectionsToClose = self.servers.length;
  // If we have a ha process running kill it
  if(self._replicasetTimeoutId != null) clearInterval(self._replicasetTimeoutId);
  self._replicasetTimeoutId = null;
  // Close all proxy connections
  for(var i = 0; i < self.servers.length; i++) {
    self.servers[i].close(function(err, result) {
      numberOfConnectionsToClose = numberOfConnectionsToClose - 1;
      // Callback if we have one defined
      if(numberOfConnectionsToClose == 0 && typeof callback == 'function') {
        callback(null);
      }
    });
  }
}

/**
 * @ignore
 * Return the used state
 */
Mongos.prototype._isUsed = function() {
  return this._used;
}

exports.Mongos = Mongos;