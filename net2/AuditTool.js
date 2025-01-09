/*    Copyright 2020-2024 Firewalla Inc.
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

const log = require('./logger.js')(__filename);
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const Constants = require('./Constants.js');
const LogQuery = require('./LogQuery.js')

const _ = require('lodash');

class AuditTool extends LogQuery {

  mergeLog(result, incoming) {
    result.ts = _.min([result.ts, incoming.ts])
    result.count += incoming.count
  }

  shouldMerge(previous, incoming) {
    const compareKeys = ['type', 'device', 'protocol', 'port'];
    if (!previous || !previous.type) return false
    previous.type == 'dns' ? compareKeys.push('domain', 'qc', 'qt', 'rc') : compareKeys.push('ip', 'fd')
    return _.isEqual(_.pick(previous, compareKeys), _.pick(incoming, compareKeys));
  }

  includeFirewallaInterfaces() { return true }

  optionsToFilter(options) {
    const filter = super.optionsToFilter(options)
    if (options.direction) filter.fd = options.direction;
    delete filter.dnsFlow
    return filter
  }

  async getAuditLogs(options) {
    options = options || {}
    this.checkCount(options)
    const macs = await this.expendMacs(options)

    const logs = await this.logFeeder(options, this.expendFeeds({macs}))

    return logs.slice(0, options.count)
  }

  toSimpleFormat(entry, options = {}) {
    const f = {
      ltype: options.block == undefined || options.block ? 'audit' : 'flow',
      type: options.dnsFlow ? 'dnsFlow' : entry.type,
      ts: entry._ts || entry.ts + (entry.du || 0),
      count: entry.ct,
    };
    if (entry.pr) f.protocol = entry.pr
    if (entry.intf) f.intf = networkProfileManager.prefixMap[entry.intf] || entry.intf

    if (_.isObject(entry.af) && !_.isEmpty(entry.af))
      f.appHosts = Object.keys(entry.af);

    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      if (entry[config.flowKey] && entry[config.flowKey].length)
        f[config.flowKey] = entry[config.flowKey];
    }

    if (entry.rl) {
      // real IP:port of the client in VPN network
      f.rl = entry.rl;
    }

    if (entry.ac === "isolation") {
      if (entry.isoGID)
        f.isoGID = entry.isoGID;
      if (entry.isoNID)
        f.isoNID = entry.isoNID;
    }

    if (entry.dmac) {
      f.dstMac = entry.dmac
    }
    if (entry.drl) {
      f.drl = entry.drl
    }
    if (entry.pid) {
      f.pid = entry.pid
    }
    if (entry.reason) {
      f.reason = entry.reason
    }
    if (entry.wanIntf) {
      f.wanIntf = networkProfileManager.prefixMap[entry.wanIntf] || entry.wanIntf
    }


    if (options.dnsFlow || entry.type == 'dns') {
      f.domain = entry.dn
      if (entry.as) f.answers = entry.as
    } else {
      if (entry.tls) f.type = 'tls'
      f.fd = entry.fd
    }

    try {
      if (entry.type == 'ip') {
        if (entry.fd !== 'out') { // 'in' && 'lo'
          f.port = Number(entry.dp);
          f.devicePort = Number(entry.sp[0]);
        } else {
          f.port = Number(entry.sp[0]);
          f.devicePort = Number(entry.dp);
        }
      } else {
        f.port = Number(entry.dp);
      }
    } catch(err) {
      log.debug('Failed to parse port', err)
    }

    if (entry.type == 'dns' || entry.fd !== 'out') {
      f.ip = entry.dh;
      f.deviceIP = entry.sh;
    } else { // ip.out
      f.ip = entry.sh;
      f.deviceIP = entry.dh;
    }

    return f;
  }

  getLogKey(mac, options) {
    // options.block == null is also counted here
    return options.block == undefined || options.block
      ? `audit:drop:${mac}`
      : options.dnsFlow ? `flow:dns:${mac}` : `audit:accept:${mac}`
  }
}

module.exports = new AuditTool()
