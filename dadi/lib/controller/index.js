'use strict'

/**
 * @module Controller
 */
var _ = require('underscore')
var async = require('async')
var crypto = require('crypto')
var debug = require('debug')('web:controller')
var path = require('path')
var url = require('url')

var config = require(path.join(__dirname, '/../../../config.js'))
var help = require(path.join(__dirname, '/../help'))
var log = require('@dadi/logger')

var Datasource = require(path.join(__dirname, '/../datasource'))
var Event = require(path.join(__dirname, '/../event'))
var Providers = require(path.join(__dirname, '/../providers'))
var View = require(path.join(__dirname, '/../view'))
var Send = require(path.join(__dirname, '/../view/send'))
var Cache = require(path.join(__dirname, '/../cache'))

/**
 *
 */
var Controller = function (page, options, meta, engine, cache) {
  if (!page) throw new Error('Page instance required')

  Controller.numInstances = (Controller.numInstances || 0) + 1
  // console.log('Controller:', Controller.numInstances)

  this.page = page

  this.options = options || {}
  this.meta = meta || {}
  this.engine = engine
  this.cacheLayer = Cache(cache)

  this.datasources = {}
  this.events = []
  this.preloadEvents = []

  this.attachDatasources(err => {
    if (err) {
      log.error({ module: 'controller' }, err)
      throw err
    }
  })

  this.attachEvents(() => {})
}

/**
 *
 */
Controller.prototype.attachDatasources = function (done) {
  if (this.page.datasources.length === 0) return done(null)

  var i = 0

  this.page.datasources.forEach(datasource => {
    new Datasource(this.page, datasource, this.options).init((err, ds) => {
      if (err) return done(err)

      this.datasources[ds.schema.datasource.key] = ds

      if (++i === this.page.datasources.length) {
        return done(null)
      }
    })
  })
}

/**
 *
 */
Controller.prototype.attachEvents = function (done) {
  // add global events first
  config.get('globalEvents').forEach(eventName => {
    var e = new Event(this.page.name, eventName, this.options)
    this.preloadEvents.push(e)
  })

  this.page.preloadEvents.forEach(eventName => {
    var e = new Event(this.page.name, eventName, this.options)
    this.preloadEvents.push(e)
  })

  this.page.events.forEach(eventName => {
    var e = new Event(this.page.name, eventName, this.options)
    this.events.push(e)
  })

  done()
}

/**
 *
 */
Controller.prototype.requiredDataPresent = function (data) {
  if (_.isEmpty(this.page.requiredDatasources)) return true

  return _.every(this.page.requiredDatasources, function (datasource) {
    return (
      data.hasOwnProperty(datasource) &&
      data[datasource].hasOwnProperty('results') &&
      data[datasource].results.length !== 0
    )
  })
}

/**
 *
 */
Controller.prototype.buildInitialViewData = function (req) {
  var data = {}

  // data helpers
  data.has = function (node) {
    return this[node] !== undefined
  }

  data.hasResults = function (node) {
    return (
      this.has(node) &&
      this[node].results !== undefined &&
      !_.isEmpty(this[node].results)
    )
  }

  var urlData = url.parse(req.url, true)

  data.query = urlData.query
  data.params = {}
  data.pathname = ''
  data.host = req.headers.host
  data.page = this.meta

  if (urlData.pathname.length) data.pathname = urlData.pathname

  // add request params (params from the path, e.g. /:make/:model)
  _.extend(data.params, req.params)

  // add query params (params from the querystring, e.g. /reviews?page=2)
  _.extend(data.params, data.query)

  if (req.error) data.error = req.error

  // add id component from the request
  if (req.params.id) data.id = decodeURIComponent(req.params.id)

  // allow JSON view using ?json=true
  var json =
    config.get('allowJsonView') &&
    urlData.query.json &&
    urlData.query.json.toString() === 'true'

  data.title = this.page.name
  data.global = config.has('global') ? config.get('global') : {} // global values from config
  data.debug = config.get('debug')
  data.json = json || false

  if (config.get('security.csrf')) {
    data.csrfToken = req.csrfToken()
  }

  delete data.query.json
  delete data.params.json

  return data
}

/**
 *
 */
Controller.prototype.process = function process (req, res, next) {
  debug('%s %s', req.method, req.url)
  help.timer.start(req.method.toLowerCase())

  var statusCode = res.statusCode || 200
  var data = this.buildInitialViewData(req)
  var view = new View(req.url, this.page, data.json)

  var done = data.json
    ? Send.json(statusCode, res, next)
    : Send.html(res, req, next, statusCode, this.page.contentType)

  this.loadData(req, res, data, (err, data, dsResponse) => {
    // return 404 if requiredDatasources contain no data
    if (!this.requiredDataPresent(data)) {
      return next()
    }

    if (err) {
      if (err.statusCode && err.statusCode === 404) return next()
      return done(err)
    }

    // If we received a response back from the datasource, and
    // not just the data, send the whole response back
    if (dsResponse) {
      if (dsResponse.statusCode === 202) {
        done = Send.json(dsResponse.statusCode, res, next)
        return done(null, data)
      }
    }

    help.timer.stop(req.method.toLowerCase())
    if (data) data.stats = help.timer.getStats()

    if (data) data.version = help.getVersion()

    view.setData(data)

    if (data.json) {
      return done(null, data)
    }

    view.render((err, result) => {
      if (err) return next(err)
      return done(null, result)
    })
  })
}

function hasAttachedDatasources (datasources) {
  return typeof datasources === 'object' && Object.keys(datasources).length > 0
}

/**
 *
 */
Controller.prototype.post = function (req, res, next) {
  return this.process(req, res, next)
}

/**
 *
 */
Controller.prototype.get = function (req, res, next) {
  return this.process(req, res, next)
}

/**
 *
 */
Controller.prototype.head = function (req, res, next) {
  return this.get(req, res, next)
}

Controller.prototype.loadEventData = function (events, req, res, data, done) {
  // return the global data object, no events to run
  if (Object.keys(events).length === 0) {
    return done(null, data)
  }

  let queue = Promise.resolve(true)

  events.forEach(event => {
    queue = queue.then(() => {
      return new Promise((resolve, reject) => {
        help.timer.start('event: ' + event.name)

        // add a random value to the data obj so we can check if an
        // event has sent back the obj - in which case we assign it back
        // to itself
        var checkValue = crypto
          .createHash('md5')
          .update(new Date().toString())
          .digest('hex')

        data.checkValue = checkValue

        event.run(req, res, data, (err, result) => {
          help.timer.stop('event: ' + event.name)

          if (err) return reject(err)

          // if we get data back with the same checkValue property,
          // reassign it to our global data object to avoid circular JSON
          if (result && result.checkValue && result.checkValue === checkValue) {
            data = result
          } else if (result) {
            // add the result to our global data object
            data[event.name] = result
          }

          return resolve(data)
        })
      })
    })
  })

  return queue.then(() => done(null, data)).catch(err => done(err))
}

Controller.prototype.loadData = function (req, res, data, done) {
  var self = this

  var primaryDatasources = {}
  var chainedDatasources = {}

  debug(
    'datasources %o %o',
    _.map(self.datasources, ds => {
      return ds.name
    })
  )

  _.each(self.datasources, function (ds, key) {
    if (ds.chained) {
      chainedDatasources[key] = _.clone(ds)
    } else {
      primaryDatasources[key] = _.clone(ds)
    }
  })

  debug(
    'loadData %o %o',
    _.map(primaryDatasources, ds => {
      return ds.name
    }),
    _.map(chainedDatasources, ds => {
      return ds.name
    })
  )

  help.timer.start('load data')

  async.waterfall(
    [
      // Run PreLoad Events
      function (callback) {
        help.timer.start('preload data')
        self.loadEventData(
          self.preloadEvents,
          req,
          res,
          data,
          (err, result) => {
            if (err) return done(err)
            help.timer.stop('preload data')
            callback(null)
          }
        )
      },

      // Run datasources
      function (callback) {
        if (!hasAttachedDatasources(self.datasources)) {
          callback(null)
        }

        var queue = async.queue((ds, cb) => {
          if (ds.filterEvent) {
            ds.filterEvent.run(req, res, data, (err, filter) => {
              if (err) return done(err)
              ds.schema.datasource.filterEventResult = filter
            })
          }

          help.timer.start('datasource: ' + ds.name)

          ds.provider = new Providers[ds.source.type]()
          ds.provider.initialise(ds, ds.schema)

          // var requestUrl = processSearchParameters(ds.schema.datasource.key, ds, req)
          processSearchParameters(ds.schema.datasource.key, ds, req)

          /**
         * Call the data provider's load method to obtain data
         * for this datasource
         * @returns err, {Object} result, {Object} dsResponse
         */
          // ds.provider.load(requestUrl, function (err, result, dsResponse) {
          ds.provider.load(req.url, (err, result, dsResponse) => {
            if (err) return done(err)

            help.timer.stop('datasource: ' + ds.name)

            if (ds.provider.destroy) {
              ds.provider.destroy()
            }

            ds.provider = null

            if (dsResponse) return done(null, result, dsResponse)

            // TODO: simplify this, doesn't require a try/catch
            if (result) {
              try {
                data[ds.schema.datasource.key] = result
              } catch (e) {
                console.log('Provider Load Error:', ds.name, req.url)
                console.log(e)
              }
            }

            cb()
          })
        }, 1)

        // queue finished
        queue.drain = function () {
          callback(null)
        }

        // add each primary datasource to the queue for processing
        _.each(primaryDatasources, datasource => {
          queue.push(datasource)
        })
      },

      // Run chained datasources
      function (callback) {
        self.processChained(chainedDatasources, data, req, (err, result) => {
          if (err) return done(err)
          callback(null)
        })
      },

      // Run events
      function (callback) {
        self.loadEventData(self.events, req, res, data, (err, result) => {
          if (err) return done(err)
          callback(null)
        })
      }
    ],
    // final results
    function (err) {
      help.timer.stop('load data')
      done(err, data)
    }
  )
}

Controller.prototype.processChained = function (
  chainedDatasources,
  data,
  req,
  done
) {
  var idx = 0
  var self = this

  if (Object.keys(chainedDatasources).length === 0) {
    return done(null, data)
  }

  _.each(chainedDatasources, (chainedDatasource, chainedKey) => {
    debug(
      'datasource (chained): %s > %s',
      chainedDatasource.chained.datasource,
      chainedKey
    )
    help.timer.start('datasource: ' + chainedDatasource.name + ' (chained)')

    if (!data[chainedDatasource.chained.datasource]) {
      var message =
        "Chained datasource '" +
        chainedDatasource.name +
        "' expected to find data from datasource '" +
        chainedDatasource.chained.datasource +
        "'."
      var err = new Error()
      err.message = message
      log.warn({ module: 'controller' }, message)
      return done(err)
    }

    // find the value of the parameter in the returned data
    // to use in the chained datasource
    var param = ''

    try {
      param = chainedDatasource.chained.outputParam.param
        .split('.')
        .reduce(function (o, x) {
          return o ? o[x] : ''
        }, data[chainedDatasource.chained.datasource])
    } catch (e) {
      return done(e)
    }

    // cast the param value if needed
    if (
      chainedDatasource.chained.outputParam.type &&
      chainedDatasource.chained.outputParam.type === 'Number'
    ) {
      param = parseInt(param)
    } else {
      param = encodeURIComponent(param)
    }

    // does the parent page require no cache?
    if (data.query.cache === 'false') {
      chainedDatasource.schema.datasource.cache = false
    }

    if (self.page.passFilters && chainedDatasource.schema.datasource.paginate) {
      chainedDatasource.schema.datasource.page =
        data.query.page || req.params.page || 1
    }

    // if there is a field to filter on, add the new parameter value to the filters
    if (chainedDatasource.chained.outputParam.field) {
      chainedDatasource.schema.datasource.filter[ // eslint-disable-line
        chainedDatasource.chained.outputParam.field
      ] = param
    }

    // if the datasource specified a query, add it to the existing filter
    // by looking for the placeholder value
    if (chainedDatasource.chained.outputParam.query) {
      var placeholder = '"{' + chainedDatasource.chained.datasource + '}"'
      var filter = JSON.stringify(chainedDatasource.schema.datasource.filter)
      var q = JSON.stringify(chainedDatasource.chained.outputParam.query)

      if (typeof param !== 'number') {
        param = '"' + param + '"'
      }

      q = q.replace(/"\{param\}"/i, param)

      filter = filter.replace(placeholder, q)

      chainedDatasource.schema.datasource.filter = JSON.parse(filter)
    }

    chainedDatasource.provider = new Providers[chainedDatasource.source.type]()
    chainedDatasource.provider.initialise(
      chainedDatasource,
      chainedDatasource.schema
    )

    // var requestUrl = chainedDatasource.provider.buildEndpoint(chainedDatasource.schema.datasource)
    chainedDatasource.provider.buildEndpoint(
      chainedDatasource.schema.datasource
    )

    // debug('datasource (load): %s %s', chainedDatasource.name, requestUrl)
    debug(
      'datasource (load): %s %s',
      chainedDatasource.name,
      chainedDatasource.provider.endpoint
    )

    // chainedDatasource.provider.load(requestUrl, (err, chainedData) => {
    chainedDatasource.provider.load(req.url, (err, chainedData) => {
      if (err) log.error({ module: 'controller' }, err)

      help.timer.stop('datasource: ' + chainedDatasource.name + ' (chained)')

      // TODO: simplify this, doesn't require a try/catch
      if (chainedData) {
        try {
          data[chainedKey] = chainedData
        } catch (e) {
          log.error({ module: 'controller' }, e)
        }
      }

      idx++

      if (idx === Object.keys(chainedDatasources).length) {
        return done(null, data)
      }
    })
  })
}

function processSearchParameters (key, datasource, req) {
  // process each of the datasource's requestParams, testing for their existence
  // in the querystring's request params e.g. /car-reviews/:make/:model
  // return datasource.processRequest(key, req)
  datasource.processRequest(key, req)
}

module.exports = function (page, options, meta, engine) {
  return new Controller(page, options, meta, engine)
}

module.exports.Controller = Controller
