var http = require('http');
var url = require('url');
var pathToRegexp = require('path-to-regexp');
var _ = require('underscore');
var logger = require(__dirname + '/../log');

var Api = function () {
    this.paths = [];
    this.all = [];
    this.errors = [];

    // always add default error handler in case the application doesn't define one
    this.errors.push(defaultError());

    // permanently bind context to listener
    this.listener = this.listener.bind(this);
};

/**
 *  Connects a handler to a specific path
 *  @param {String} path
 *  @param {Controller} handler
 *  @return undefined
 *  @api public
 */
Api.prototype.use = function (path, handler) {
    if (typeof path === 'function') {
        if (path.length === 4) return this.errors.push(path);
        return this.all.push(path);
    }

    var tokens = pathToRegexp.parse(path);

    var staticRouteLength = 0;
    if (typeof tokens[0] === 'string') {
        staticRouteLength = _.compact(tokens[0].split('/')).length;
    }
    
    var regex = pathToRegexp(path);
    
    var requiredParamLength = _.filter(regex.keys, function (key) {
        return !key.optional;
    }).length;
    
    var optionalParamLength = _.filter(regex.keys, function (key) {
        return key.optional;
    }).length;
    
    var order = (staticRouteLength * 5) + (requiredParamLength * 2) + (optionalParamLength);
    if (path.indexOf('/config') > 0) order = -10;

    this.paths.push({
        path: path,
        order: order,
        handler: handler,
        regex: regex
    });

    this.paths.sort(function (a,b) {
        return b.order - a.order;
    });
};

/**
 *  Removes a handler or removes the handler attached to a specific path
 *  @param {String} path
 *  @return undefined
 *  @api public
 */
Api.prototype.unuse = function (path) {
    var indx;
    if (typeof path === 'function') {
        if (path.length === 4) {
            indx = this.errors.indexOf(path);
            return !!~indx && this.errors.splice(indx, 1);
        }
        indx = this.all.indexOf(path);
        return !!~indx && this.all.splice(indx, 1);
    }
    var path = _.findWhere(this.paths, { path: path });
    this.paths = _.without(this.paths, path);
}

/**
 *  convenience method that creates http server and attaches listener
 *  @param {Number} port
 *  @param {String} host
 *  @param {Number} backlog
 *  @param {Function} [done]
 *  @return http.Server
 *  @api public
 */
Api.prototype.listen = function (port, host, backlog, done) {
    return http.createServer(this.listener).listen(port, host, backlog, done);
};

/**
 *  listener function to be passed to node's `createServer`
 *  @param {http.IncomingMessage} req
 *  @param {http.ServerResponse} res
 *  @return undefined
 *  @api public
 */
Api.prototype.listener = function (req, res) {

    // clone the middleware stack
    var stack = this.all.slice(0);
    var path = url.parse(req.url).pathname;

    // get matching routes, and add req.params
    var matches = this._match(path, req);

    var doStack = function (i) {
        return function (err) {
            if (err) return errStack(0)(err);
            stack[i](req, res, doStack(++i));
        };
    };

    var self = this;
    var errStack = function (i) {
        return function (err) {
            self.errors[i](err, req, res, errStack(++i));
        };
    };

    // add path specific handlers
    stack = stack.concat(matches);

    // add 404 handler
    stack.push(notFound(this, req, res));

    // start going through the middleware/routes
    doStack(0)();
};

/**
 *  Check if any of the registered routes match the current url, if so populate `req.params`
 *  @param {String} path
 *  @param {http.IncomingMessage} req
 *  @return Array
 *  @api private
 */
Api.prototype._match = function (path, req) {
    var paths = this.paths;
    var matches = [];
    var handlers = [];

    console.log(req.url);

    // always add params object to avoid need for checking later
    req.params = {};

    for (i = 0; i < paths.length; i++) {
        var match = paths[i].regex.exec(path);

        console.log(paths[i]);

        if (!match) { continue; }

        var keys = paths[i].regex.keys;
        handlers.push(paths[i].handler);

        console.log(JSON.stringify(match));

        match.forEach(function (k, i) {
            var keyOpts = keys[i] || {};
            console.log("k: " + k);
            console.log("i: " + i);
            console.log("keys[i]: "+ JSON.stringify(keys[i]));
            console.log("keyOpts: " + JSON.stringify(keyOpts));
            console.log("match[i + 1]: " + match[i + 1]);
            if (match[i + 1] && keyOpts.name) req.params[keyOpts.name] = match[i + 1];
            console.log(req.params);
        });

        break;
    }

    return handlers;
};

module.exports = function () {
    return new Api();
};

module.exports.Api = Api;

// Default error handler, in case application doesn't define error handling
function defaultError() {
    return function (err, req, res) {
        logger.prod(err);
        res.statusCode = err.statusCode || 500;
        if (err.json) {
            var resBody = JSON.stringify(err.json);
            res.setHeader('content-type', 'application/json');
            res.setHeader('content-length', Buffer.byteLength(resBody));
            return res.end(resBody);
        }

        res.end();
    }
}

// return a 404
function notFound(api, req, res) {
    return function () {

        res.statusCode = 404;

        // look for a 404 page that has been loaded
        // along with the rest of the API, and call its
        // handler if it exists

        var path = _.findWhere(api.paths, { path: '/404' });
        if (path) {
            path.handler(req, res);
        }
        // otherwise, respond with default message
        else {
            res.end("404: Ain't nothing here but you and me.");
        }
    }
}
