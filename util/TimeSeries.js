/*    Copyright 2016-2024 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';
const TimeSeries = require('redis-timeseries')
const _ = require('lodash')

const log = require('../net2/logger.js')(__filename, 'info');
const rclient = require('../util/redis_manager.js').getMetricsRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');

let timezone;

const oneDay = 86400;

sclient.on("message", async (channel, message) => {
  if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
    log.info(`System timezone is reloaded, update timezone`, message);
    timezone = message;
  }
});
sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);

const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

// Get current timestamp in seconds
var getCurrentTime = function() {
  return Math.floor(Date.now() / 1000);
};

// Round timestamp to the 'precision' interval (in seconds)
var getRoundedTime = function (precision, time, skipTzCheck) {
  time = time || getCurrentTime();
  let ts = Math.floor(time / precision) * precision;
  // if it is keyTimestamp, return ts directly
  // only 1day and 1month granularity need check timezone
  if (skipTzCheck || precision < oneDay) return ts;
  let timeDate, tsDate;
  if (!timezone) {
    timeDate = moment(time * 1000).get('date');
    tsDate = moment(ts * 1000).get('date');
  } else {
    timeDate = moment(time * 1000).tz(timezone).get('date');
    tsDate = moment(ts * 1000).tz(timezone).get('date');
  }
  if (timeDate == tsDate) { // same day
    return ts;
  } else { // not same day
    if (ts > time) { // reduce one day of ts
      ts = ts - oneDay;
    } else {
      ts = ts + oneDay;
    }
    return ts;
  }
};

// override recordHit function
/**
 * Record a hit for the specified stats key
 * This method is chainable:
 * --> var ts = new TimeSeries(redis)
 *              .recordHit("messages")
 *              .recordHit("purchases", ts)
 *              .recordHit("purchases", ts, 3)
 *              ...
 *              .exec([callback]);
 *
 * `timestamp` should be in seconds, and defaults to current time.
 * `increment` should be an integer, and defaults to 1
 */
TimeSeries.prototype.recordHit = function(key, timestamp, increment, callback=()=>{}) {
  var self = this;

  Object.keys(this.granularities).forEach(function(gran) {
    var properties = self.granularities[gran],
        keyTimestamp = getRoundedTime(properties.precision || properties.ttl, timestamp,true), // high prority: precision
        tmpKey = [self.keyBase, key, gran, keyTimestamp].join(':'),
      hitTimestamp = getRoundedTime(properties.duration, timestamp);

    if (typeof self.redis.hincrbyAndExpireatBulk === "function") {
      self.redis.hincrbyAndExpireatBulk(tmpKey, hitTimestamp, Math.floor(increment || 1), keyTimestamp + 2 * properties.ttl, !self.noMulti)
        .catch(err => callback(err))
        .then(() => callback())
    } else {
      if (self.noMulti) {
        self.redis.hincrby(tmpKey, hitTimestamp, Math.floor(increment || 1), (err) => {
          if(err) {
            callback(err)
            return
          }
          self.redis.expireat(tmpKey, keyTimestamp + 2 * properties.ttl, (err2) => {
            callback(err2)
          });
        });
      } else {
        self.pendingMulti.hincrby(tmpKey, hitTimestamp, Math.floor(increment || 1));
        self.pendingMulti.expireat(tmpKey, keyTimestamp + 2 * properties.ttl);
      }
    }
  });

  return this;
};

/**
 * Execute the current pending redis multi
 */
TimeSeries.prototype.exec = function(callback = ()=>{}) {
  if(this.noMulti) {
    callback()
    return
  }

  if (typeof this.redis.execBatch === "function") {
    this.redis.execBatch().then(() => callback())
    return
  }
  // Reset pendingMulti before proceeding to
  // avoid concurrent modifications
  var current = this.pendingMulti;
  this.pendingMulti = this.redis.batch();
  current.exec(callback);
  current = null
};


// override getHits function
TimeSeries.prototype.getHits = function(key, gran, count, callback) {
  var properties = this.granularities[gran],
      currentTime = getCurrentTime();

  if (typeof properties === "undefined") {
    return callback(new Error("Unsupported granularity: "+gran));
  }

  if (count > properties.ttl / properties.duration) {
    return callback(new Error("Count: "+count+" exceeds the maximum stored slots for granularity: "+gran));
  }

  var from = getRoundedTime(properties.duration, currentTime - count*properties.duration),
      to = getRoundedTime(properties.duration, currentTime);

  const hget = {}
  const orderedKeys = []
  for(var ts=from; ts<=to; ts+=properties.duration) {
    var keyTimestamp = getRoundedTime(properties.precision || properties.ttl, ts,true), // high prority: precision
        tmpKey = [this.keyBase, key, gran, keyTimestamp].join(':');

    if (!hget[tmpKey]) {
      hget[tmpKey] = [ts]
      orderedKeys.push(tmpKey)
    } else
      hget[tmpKey].push(ts)
  }

  const multi=this.redis.multi()
  for (const key of orderedKeys) {
    multi.hmget(key, hget[key])
  }

  multi.exec(function(err, results) {
    if (err) {
      return callback(err);
    }
    const flatten = _.flatten(results)
    for(var ts=from, i=0, data=[]; ts<=to; ts+=properties.duration, i+=1) {
      data.push([ts, flatten[i] ? parseInt(flatten[i], 10) : 0]);
    }

    return callback(null, data.slice(Math.max(data.length - count, 0)));
  });
};

const timeSeries = new TimeSeries(rclient, "timedTraffic")
timeSeries.granularities = {
  '1minute'  : { ttl: timeSeries.minutes(65)  , duration: timeSeries.minutes(1) },
  '15minutes': { ttl: timeSeries.hours(50)  , duration: timeSeries.minutes(15) },
  '1hour'    : { ttl: timeSeries.days(7)   , duration: timeSeries.hours(1) },
  '1day'     : { ttl: timeSeries.weeks(53) , duration: timeSeries.days(1), precision:timeSeries.weeks(52) },
  '1month'   : { ttl: timeSeries.months(24) , duration: timeSeries.months(1) }
}

const boneAPITimeSeries = new TimeSeries(rclient, "boneAPIUsage")
boneAPITimeSeries.granularities = {
  '1minute'  : { ttl: boneAPITimeSeries.minutes(60)  , duration: boneAPITimeSeries.minutes(1) },
  '1hour'    : { ttl: boneAPITimeSeries.days(7)   , duration: boneAPITimeSeries.hours(1) },
  '1day'     : { ttl: boneAPITimeSeries.days(30) , duration: boneAPITimeSeries.days(1) },
}
boneAPITimeSeries.noMulti = true

// set flag
const timeSeriesWithTzBeginingTs = "time_series_with_tz_ts";
(async () => {
  const ts = await rclient.hgetAsync("sys:config", timeSeriesWithTzBeginingTs)
  if (!ts) {
    await rclient.hsetAsync("sys:config", timeSeriesWithTzBeginingTs, new Date() / 1000);
  }
})()

module.exports = {
  getTimeSeries: function () { return timeSeries },
  getBoneAPITimeSeries: function () { return boneAPITimeSeries }
}
