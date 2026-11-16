// A class used to manage the history of an object
// inserting history into sis_history
// Does not subclass Manager

'use strict';

var jsondiff = require('jsondiffpatch');
var SIS = require('./constants');

var docToPojo = function(doc) {
    if (typeof doc.toObject === 'function') {
        doc = doc.toObject();
    }
    // return JSON.parse(JSON.stringify(doc));
    return doc;
};

var differ = jsondiff.create({
    objectHash: function(obj) {
        // serialize the objects within an array to JSON
        return JSON.stringify(obj);
    }
});

// Take in a schemaManager
function CommitManager(schemaManager) {

    var self = this;

    // default id field (schemas, hook, hiera)
    this.idField = 'name';
    self.model = schemaManager.getSisModel(SIS.SCHEMA_COMMITS);

    function createCommitObject(oldDoc, newDoc, user, type, ts) {
        var id = oldDoc ? oldDoc[self.idField] : newDoc[self.idField];
        var oid = oldDoc ? oldDoc._id : newDoc._id;
        var action = oldDoc ? (newDoc ? "update" : "delete") : "insert";
        var doc = { 'type' : type,
                    'entity_id' : id,
                    'action' : action,
                    'entity_oid' : oid };
        if (user && user[SIS.FIELD_NAME]) {
            doc[SIS.FIELD_MODIFIED_BY] = user[SIS.FIELD_NAME];
        }
        switch (action) {
            case 'insert':
                doc.commit_data = docToPojo(newDoc);
                doc.date_modified = newDoc[SIS.FIELD_SIS_META][SIS.FIELD_UPDATED_AT];
                break;
            case 'delete':
                doc.commit_data = docToPojo(oldDoc);
                doc.date_modified = ts;
                break;
            case 'update':
                // oldDoc is an object, newDoc is a doc
                var left = docToPojo(oldDoc);
                var right = docToPojo(newDoc);
                doc.commit_data = differ.diff(left, right);
                var mod_date = newDoc[SIS.FIELD_SIS_META][SIS.FIELD_UPDATED_AT];
                var hasChanged = doc.commit_data && Object.keys(doc.commit_data).some(function(k) {
                    return k[0] != '_';
                });
                if (!hasChanged) {
                    // just exit
                    return null;
                }
                doc.date_modified = mod_date;
                break;
            default:
                break;
        }
        var commitMeta = {};
        commitMeta[SIS.FIELD_UPDATED_AT] = ts;
        commitMeta[SIS.FIELD_CREATED_AT] = ts;
        doc[SIS.FIELD_SIS_META] = commitMeta;
        return doc;
    }

    // Record the commits of a bulk operation.  For updates, items are what
    // update resolved with ({ old, updated }).  Resolves with items.
    this.recordHistoryBulk = async function(items, user, action, type) {
        var ts = Date.now();
        var commits = [];

        if (action === "insert") {
            commits = items.map(function(item) {
                return createCommitObject(null, item, user, type, ts);
            });
        } else if (action === "delete") {
            commits = items.map(function(item) {
                return createCommitObject(item, null, user, type, ts);
            });
        } else {
            commits = items.map(function(item) {
                return createCommitObject(item.old, item.updated, user, type, ts);
            }).filter(function(item) {
                return item !== null;
            });
        }
        commits = commits.map(function(c) {
            return new self.model(c).toObject();
        });
        if (commits.length) {
            // do a bulk insert directly
            await self.model.collection.insertMany(commits);
        }
        return items;
    };

    // Record the commit of a single operation.  Resolves with the commit, or
    // null if an update changed nothing.
    this.recordHistory = async function(oldDoc, newDoc, user, type) {
        var doc = createCommitObject(oldDoc, newDoc, user, type, Date.now());
        if (!doc) {
            return null;
        }
        try {
            return await new self.model(doc).save();
        } catch (err) {
            throw SIS.ERR_INTERNAL(err);
        }
    };

    // aggregate commits where the first commit is the insert
    // followed by a series of updates (patches).  Returns null if
    // there is no insert to start from (tracking was enabled later)
    var aggregateCommits = function(commits) {
        // TODO: look into offloading to node-webworker-threads
        // if intense
        var initial = commits.shift();
        if (!initial || initial.action !== 'insert') {
            return null;
        }
        var patched = commits.reduce(function(obj, commit) {
            // apply commit.commit_data to obj
            if (commit.commit_data) {
                jsondiff.patch(obj, commit.commit_data);
            }
            return obj;
        }, initial.commit_data);
        return patched;
    };

    // Resolves with the commits on the object up to timestamp, starting
    // with its latest insert - or [] if there is none
    this.getCommitsOnObject = async function(id, type, timestamp) {
        var condition = {
            entity_id : id,
            type : type,
            date_modified : { $lte : timestamp },
            action : 'insert'
        };
        try {
            // find the first commit
            var first = await self.model.findOne(condition).select('date_modified entity_oid')
                .sort({ date_modified : -1 }).exec();
            if (!first) {
                return [];
            }
            delete condition.action;
            condition.entity_oid = first.entity_oid;
            condition.date_modified = { $lte : timestamp, $gte : first.date_modified };
            var commits = await self.model.find(condition).select('commit_data action entity_oid')
                .sort({ date_modified : 1 }).exec();
            return commits || [];
        } catch (err) {
            return [];
        }
    };

    // Resolves with the object as it was after the commit
    this.applyDiff = async function(result) {
        // get the low hanging fruit ones out
        if (result.action == 'insert' || result.action == 'delete') {
            return result.commit_data;
        } else if (result.action != 'update') {
            throw SIS.ERR_INTERNAL("unknown commit type found " + result.action);
        }
        // get the commits on the object that precede this
        var commits = await this.getCommitsOnObject(result.entity_id, result.type, result.date_modified);
        var patched = aggregateCommits(commits);
        if (!patched) {
            throw SIS.ERR_NOT_FOUND("Full commit history unavailable.");
        }
        return patched;
    };

    // Resolves with the commit hid of the object, with the object as it
    // was after the commit in value_at - or null if there is no such commit
    this.getVersionById = async function(type, id, hid) {
        var result = await self.model.findOne({ '_id' : hid }).exec();
        if (!result) {
            return null;
        }
        if (type != result.type ||
            id != result.entity_id) {
            throw SIS.ERR_NOT_FOUND("commit", hid);
        }
        var obj = await self.applyDiff(result);
        result = result.toObject();
        result.value_at = obj;
        return result;
    };

    // Resolves with the object as it was at utc
    this.getVersionByUtc = async function(type, id, utc) {
        var commits = await this.getCommitsOnObject(id, type, utc);
        if (!commits.length) {
            throw SIS.ERR_NOT_FOUND("commit", utc);
        }
        if (commits.length == 1) {
            // only one commit - it's an insert.
            return commits[0].commit_data;
        } else if (commits[commits.length - 1].action == 'delete') {
            return commits[commits.length - 1].commit_data;
        }
        // merge
        var patched = aggregateCommits(commits);
        if (!patched) {
            throw SIS.ERR_NOT_FOUND("Full commit history unavailable.");
        }
        return patched;
    };
}

module.exports = function(schemaManager) {
    return new CommitManager(schemaManager);
};
