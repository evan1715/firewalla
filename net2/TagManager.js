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

const _ = require('lodash');
const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const asyncNative = require('../util/asyncNative.js');
const Tag = require('./Tag.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const Constants = require('./Constants.js');
const dnsmasq = new DNSMASQ();
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock()

class TagManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.tags = {};

    this.scheduleRefresh();

    this.subscriber.subscribeOnce("DiscoveryEvent", "Tags:Updated", null, async (channel, type, id, obj) => {
      this.scheduleRefresh();
    });

    return this;
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(async () => {
      await this.refreshTags();
      if (f.isMain()) {
        if (sysManager.isIptablesReady()) {
          for (let uid in this.tags) {
            const tag = this.tags[uid];
            tag.scheduleApplyPolicy();
          }
        }
      }
    }, 1000);
  }

  async toJson() {
    const json = {};
    for (let uid in this.tags) {
      await this.tags[uid].loadPolicyAsync();
      json[uid] = this.tags[uid].toJson();
    }
    return json;
  }

  async _getNextTagUid() {
    let uid = await rclient.getAsync("tag:uid");
    if (!uid) {
      uid = 1;
      await rclient.setAsync("tag:uid", uid);
    }
    await rclient.incrAsync("tag:uid");
    return String(uid);
  }

  async createTag(name, obj, affiliatedName, affiliatedObj) {
    if (!obj)
      obj = {};
    const type = obj.type || Constants.TAG_TYPE_GROUP;
    if (!Constants.TAG_TYPE_MAP[type]) {
      log.error('Unsupported tag type:', type)
      return null
    }

    return lock.acquire(`createTag_${name}_${type}`, async() => {
      let afTag = null;
      // create a native affiliated device group for this tag, usually affiliated to a user group
      if (affiliatedName && affiliatedObj) {
        afTag = await this.createTag(affiliatedName, affiliatedObj);
        if (afTag) {
          obj.affiliatedTag = afTag.getUniqueId();
        }
      }

      const existingTag = this.getTagByName(name, type)
      if (existingTag) {
        if (obj) {
          existingTag.o = Object.assign({}, obj, {uid: existingTag.getUniqueId(), name});
          existingTag.save()
          this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, existingTag.o);
        }
        if (afTag)
          await afTag.setPolicyAsync(Constants.TAG_TYPE_MAP[type].policyKey, [ existingTag.getUniqueId() ]);
        return existingTag
      }

      const newUid = await this._getNextTagUid();
      const now = Math.floor(Date.now() / 1000);
      const newTag = new Tag(Object.assign({}, obj, {uid: newUid, name: name, createTs: now}))
      await newTag.save()
      this.tags[newUid] = newTag

      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, newTag);
      if (afTag) {
        await afTag.setPolicyAsync(Constants.TAG_TYPE_MAP[type].policyKey, [ String(newUid) ]);
        newTag.afTag = afTag
      }

      return newTag
    })
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async removeTag(uid, name, type = Constants.TAG_TYPE_GROUP) { // remove tag by name is for backward compatibility
    uid = String(uid);
    if (_.has(this.tags, uid)) {
      const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [this.tags[uid].getTagType(), "redisKeyPrefix"]);
      const key = keyPrefix && `${keyPrefix}${uid}`;
      key && await rclient.unlinkAsync(key);
      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
      await this.refreshTags();
      return;
    }
    if (name && type) {
      const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [type, "redisKeyPrefix"]);
      if (keyPrefix) {
        for (let uid in this.tags) {
          if (this.tags[uid].o && this.tags[uid].o.name === name) {
            const key = `${keyPrefix}${uid}`;
            await rclient.unlinkAsync(key);
            this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
            await this.refreshTags();
            return;
          }
        }
      }
    }
    log.warn(`Tag ${uid} does not exist, no need to remove it`);
  }

  async updateTag(uid, name, obj = {}) {
    uid = String(uid);
    if (_.has(this.tags, uid)) {
      const tag = this.tags[uid];
      const type = obj.type || tag.o.type || Constants.TAG_TYPE_GROUP; // keep original type if not defined in obj
      let changed = false;
      if (tag.getTagName() !== name) {
        tag.setTagName(name);
        changed = true;
      }
      // different type of tags are saved in different redis hash keys
      if (tag.o.type !== type) {
        const oldType = tag.o.type || Constants.TAG_TYPE_GROUP;
        const oldPrefix = _.get(Constants.TAG_TYPE_MAP, [oldType, "redisKeyPrefix"]);
        if (oldPrefix) {
          const oldKey = `${oldPrefix}${uid}`;
          await rclient.unlinkAsync(oldKey);
        }
        changed = true;
      }
      if (type) {
        const keyPrefix = _.get(Constants.TAG_TYPE_MAP, [type, "redisKeyPrefix"]);
        if (keyPrefix) {
          const o = Object.assign({}, { uid, name }, tag.o, obj);
          const key = `${keyPrefix}${uid}`;
          await rclient.hmsetAsync(key, o);
          changed = true;
        } else return null;
      }
      if (changed) {
        this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
        await this.refreshTags();
      }
      return this.tags[uid].toJson();
    }
    return null;
  }

  getTagByUid(uid) {
    return uid && this.tags[uid];
  }

  getTagByName(name, type = Constants.TAG_TYPE_GROUP) {
    if (!name)
      return null;
    for (const tag of Object.values(this.tags)) {
      if (tag.getTagType() == type && tag.o.name === name)
        return tag;
    }
    return null;
  }

  getTag(tagName) {
    const tag = this.getTagByUid(tagName);
    if (tag) {
      return tag;
    }
    return this.getTagByName(tagName);
  }

  async getPolicyTags(policyName) {
    let policyTags = [];
    for (const uid in this.tags) {
      if (await this.tags[uid].hasPolicyAsync(policyName)){
        policyTags.push(this.tags[uid]);
      }
    }
    return policyTags;
  }

  async tagUidExists(uid, type) {
    if (this.getTagByUid(uid))
      return true;
    for (const key of Object.keys(Constants.TAG_TYPE_MAP)) {
      if (!type || type === key) {
        const redisKeyPrefix = _.get(Constants.TAG_TYPE_MAP, [key, "redisKeyPrefix"]);
        if (redisKeyPrefix) {
          const result = await rclient.typeAsync(`${redisKeyPrefix}${uid}`);
          if (result !== "none")
            return true;
        }
      }
    }
    return false;
  }

  async refreshTags() {
    log.verbose('refreshTags')
    const markMap = {};
    for (let uid in this.tags) {
      markMap[uid] = false;
    }

    const keyPrefixes = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      const redisKeyPrefix = config.redisKeyPrefix;
      keyPrefixes.push(redisKeyPrefix);
    }
    for (const keyPrefix of keyPrefixes) {
      const keys = await rclient.scanResults(`${keyPrefix}*`);
      const nameMap = {}
      for (let key of keys) {
        const o = await rclient.hgetallAsync(key);
        if (!o) continue
        const uid = key.substring(keyPrefix.length);
        // remove duplicate deviceTag
        if (o.type == Constants.TAG_TYPE_DEVICE) {
          if (nameMap[o.name]) {
            if (f.isMain()) {
              log.info('Remove duplicated deviceTag', uid)
              await rclient.unlinkAsync(key);
              this.subscriber.publish("DiscoveryEvent", "Tags:Updated");
            }
            continue
          } else {
            nameMap[o.name] = true
          }
        }
        if (this.tags[uid]) {
          await this.tags[uid].update(o);
        } else {
          this.tags[uid] = new Tag(o);
        }
        markMap[uid] = true;
      }
    }

    const removedTags = {};
    Object.keys(this.tags).filter(uid => markMap[uid] === false).map((uid) => {
      removedTags[uid] = this.tags[uid];
    });
    for (const uid in removedTags) {
      if (f.isMain()) {
        (async () => {
          await sysManager.waitTillIptablesReady()
          log.info(`Destroying environment for tag ${uid} ${removedTags[uid].name} ...`);
          await removedTags[uid].destroyEnv();
          await removedTags[uid].destroy();
          await dnsmasq.writeAllocationOption(uid, {})
        })()
      }
      delete this.tags[uid];
    }

    for (const uid in this.tags) {
      const tag = this.tags[uid]
      if (this.tags[tag.o.affiliatedTag]) {
        tag.afTag = this.tags[tag.o.affiliatedTag]
      }
    }

    return this.tags;
  }

  async loadPolicyRules() {
    await asyncNative.eachLimit(Object.values(this.tags), 10, id => id.loadPolicyAsync())
  }
}

const instance = new TagManager();
module.exports = instance;
