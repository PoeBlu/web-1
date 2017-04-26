/**
 * @module Middleware
 */
var debug = require('debug')('web:middleware')
var log = require('@dadi/logger')
var path = require('path')

var Middleware = function (name, options) {
  debug('loaded %s', name)

  this.name = name
  this.options = options || {}
}

Middleware.prototype.load = function () {
  var filepath = path.join(this.options.middlewarePath, this.name + '.js')

  try {
    // get the file
    return require(filepath)
  } catch (err) {
    throw new Error('Error loading middleware "' + filepath + '". ' + err)
  }
}

Middleware.prototype.init = function (app) {
  try {
    this.load()(app)
  } catch (err) {
    log.error({ module: 'middleware' }, err)
    throw err
  }
}

module.exports = function (name, options) {
  return new Middleware(name, options)
}

module.exports.Middleware = Middleware
