import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - History API', function() {
    var ApiServer = new TestUtil.TestServer();

    // test on sample entity, hooks, schemas, and hiera
    var data = [
        // schemas
        { "prefix" : "/api/v1.1/schemas",
          "entries" : [
            { "name" : "history_test_v11",
              _sis : { "owner" : "test" },
              "definition" : {
                "name" : "String",
                "data" : "Number"
              }
            },
            { "name" : "history_test_v11",
              _sis : { "owner" : "test" },
              "definition" : {
                "name" : "String",
                "data" : "String",
                "count" : "Number"
              }
            },
            { "name" : "history_test_v11",
              _sis : { "owner" : "test" },
              "definition" : {
                "name" : "String",
                "ip" : "Number",
                "desc" : "String"
              }
            }
          ],
          del_url : "/api/v1.1/schemas/history_test_v11"
        },

        // hooks
        { "prefix" : "/api/v1.1/hooks",
          "entries" : [
            { "name" : "hist_hook_v11",
              _sis : { "owner" : "test" },
              "entity_type" : "some_entity",
              "target" : {
                "url" : "http://www.url.com",
                "action" : "POST"
              },
              "events" : ["insert"]
            },
            { "name" : "hist_hook_v11",
              _sis : { "owner" : "test" },
              "entity_type" : "some_entity",
              "target" : {
                "url" : "http://www.url.com/get",
                "action" : "GET"
              },
              "events" : ["insert"]
            },
            { "name" : "hist_hook_v11",
              _sis : { "owner" : "test" },
              "entity_type" : "some_entity",
              "target" : {
                "url" : "http://www.url.com/post",
                "action" : "POST"
              },
              "events" : ["insert", "update"]
            }
          ],
          del_url : "/api/v1.1/hooks/hist_hook_v11"
        },

        // hiera
        { "prefix" : "/api/v1.1/hiera",
          "entries" : [
            { "name" : "hist_hiera_v11",
              _sis : { "owner" : "test" },
              "hieradata" : {
                "field" : "v1",
                "field_n" : 0
              }
            },
            { "name" : "hist_hiera_v11",
              _sis : { "owner" : "test" },
              "hieradata" : {
                "field" : null,
                "new_field" : "new",
                "field_n" : 0
              }
            },
            { "name" : "hist_hiera_v11",
              _sis : { "owner" : "test" },
              "hieradata" : {
                "field" : "v3",
                "field_n" : 20
              }
            }
          ],
          "type" : "hiera",
          del_url : "/api/v1.1/hiera/hist_hiera_v11"
        },

        // entities
        { "prefix" : "/api/v1.1/entities/history_test_v11",
          "id_field" : "_id",
          "entries" : [
            { "name" : "entity_1",
              "ip" : 10001,
              "desc" : "Awesome thing"
            },
            { "name" : "entity_10",
              "ip" : 10005,
              "desc" : "A really Awesome thing"
            },
            { "name" : "entity_10",
              "ip" : 10001,
              "desc" : null
            },
          ]
        }
    ];

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        // delete
        await Promise.all(data.map(function(d) {
            return d.del_url ? ApiServer.del(d.del_url) : null;
        }));
    });

    after(async function() {
        await ApiServer.stop();
    });

    var sleep = function(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    };

    var suffix = "_" + Date.now();
    data.map(function(test) {
        // fix for repeats
        if (test.del_url) {
            test.del_url += suffix;
            test.entries.forEach(function(ent) {
                ent.name += suffix;
            });
        } else {
            // entities
            test.prefix += suffix;
        }

        var prefix = test.prefix;
        var idField = test.id_field || 'name';
        var entries = test.entries;
        var items = [];
        describe("Testing commits for " + test.prefix, function() {
            // insert the entries
            before(async function() {
                for (var idx = 0; idx < entries.length; ++idx) {
                    var url = prefix;
                    var method = 'post';
                    var status = 201;
                    if (idx > 0) {
                        method = 'put';
                        url = prefix + "/" + items[idx - 1][idField];
                        status = 200;
                    }
                    var item = (await ApiServer.newRequest(method, url)
                        .send(entries[idx])
                        .expect(status)).body;
                    should.exist(item);
                    should.exist(item[idField]);
                    should.exist(item._sis._updated_at);
                    items.push(item);
                    // ensure get matches
                    var res = await ApiServer.get(prefix + "/" + item[idField]).expect(200);
                    if (test.type !== "hiera") {
                        item.should.eql(res.body);
                    } else {
                        var hieraResult = {};
                        hieraResult[item[idField]] = item.hieradata;
                        hieraResult.should.eql(res.body);
                    }
                    // so each commit has its own time
                    await sleep(500);
                }
            });

            var middleIdx = parseInt(entries.length / 2, 10);
            var middleItemHid = null;

            it("should retrieve " + entries.length + " commit records", async function() {
                var res = await ApiServer.newRequest('get', prefix + "/" + items[0][idField] + "/commits")
                    .query({ q : { date_modified : { $gte : items[0]._sis._created_at } }})
                    .expect(200);
                should.exist(res.body);
                res.body.length.should.eql(items.length);
                middleItemHid = res.body[middleIdx]._id;
            });

            it("should retrieve the middle item by commit id", async function() {
                var path = [prefix, items[middleIdx][idField], 'commits', middleItemHid];
                var res = await ApiServer.newRequest('get', path.join("/"))
                    .expect(200);
                should.exist(res.body);
                should.exist(res.body.value_at);
                'update'.should.eql(res.body.action);
                res.body.value_at.should.eql(items[middleIdx]);
            });

            var createTest = function(idx) {
                return async function() {
                    var utc = items[idx]._sis._updated_at;
                    var path = [prefix, items[idx][idField], 'revision', utc];
                    var res = await ApiServer.get(path.join("/"))
                        .expect(200);
                    should.exist(res.body);
                    res.body.should.eql(items[idx]);
                };
            };

            for (var i = 0; i < entries.length; ++i) {
                it("should retrieve item " + i + " by updated_at", createTest(i));
            }

            it("should retrieve the middle item by time", async function() {
                // calculate a time between the middle item and the next item
                var time = (items[middleIdx + 1]._sis._updated_at - items[middleIdx]._sis._updated_at) / 2;
                time += items[middleIdx]._sis._updated_at;
                var path = [prefix, items[0][idField], 'revision', time];
                var res = await ApiServer.newRequest('get', path.join("/"))
                    .expect(200);
                should.exist(res.body);
                res.body.should.eql(items[middleIdx]);
            });

        });
    });

    describe("Test prevent commit tracking", function() {
        var schema = {
            name : "history_test_2",
            _sis : { owner : ["sistest"] },
            definition : {
                name : "String",
                number : "Number"
            },
            track_history : false
        };
        var entity = {
            name : "e1",
            number : 1
        };
        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/history_test_2');
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            entity = (await ApiServer.post("/api/v1.1/entities/history_test_2")
                .send(entity).expect(201)).body;
            entity.number = 2;
            await ApiServer.put("/api/v1.1/entities/history_test_2/" + entity._id)
                .send(entity).expect(200);
        });

        it("Should not retrieve any commits", async function() {
            var res = await ApiServer.get("/api/v1.1/entities/history_test_2/" + entity._id + "/commits")
                .expect(200);
            res.body.should.eql([]);
        });
    });

    describe("Updating with the same content", function() {
        var schema = {
            name : "history_test_3",
            _sis : { owner : ["sistst"] },
            definition : {
                name : "String"
            }
        };

        var entity = {
            name : "testme"
        };

        before(async function() {
            await ApiServer.del('/api/v1.1/schemas/history_test_3');
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            entity = (await ApiServer.post("/api/v1.1/entities/history_test_3")
                .send(entity).expect(201)).body;
            await ApiServer.put("/api/v1.1/entities/history_test_3/" + entity._id)
                .send(entity).expect(200);
        });

        it("should only have one commit", async function() {
            var res = await ApiServer.get("/api/v1.1/entities/history_test_3/" + entity._id + "/commits")
                .expect(200);
            res.body.length.should.eql(1);
        });
    });

    describe("Commit lookups", function() {
        var schema = {
            name : "history_test_4",
            _sis : { owner : ["sistest"] },
            definition : { name : "String", n : "Number" }
        };
        var url = "/api/v1.1/entities/" + schema.name;
        var kept = null;
        var deleted = null;
        var commits = null;

        before(async function() {
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            kept = (await ApiServer.post(url).send({ name : "kept", n : 1 }).expect(201)).body;
            kept = (await ApiServer.put(url + "/" + kept._id).send({ n : 2 }).expect(200)).body;
            deleted = (await ApiServer.post(url).send({ name : "deleted", n : 1 }).expect(201)).body;
            await ApiServer.del(url + "/" + deleted._id).expect(200);
            commits = {
                kept : (await ApiServer.get(url + "/" + kept._id + "/commits").expect(200)).body,
                deleted : (await ApiServer.get(url + "/" + deleted._id + "/commits").expect(200)).body
            };
        });

        after(async function() {
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        });

        function commitUrl(entity, action) {
            var commit = commits[entity.name].filter(function(c) { return c.action === action; })[0];
            return url + "/" + entity._id + "/commits/" + commit._id;
        }

        it("should get an insert commit with the inserted object", async function() {
            var res = await ApiServer.get(commitUrl(kept, "insert")).expect(200);
            res.body.action.should.eql("insert");
            res.body.value_at.n.should.eql(1);
        });

        it("should get an update commit with the updated object", async function() {
            var res = await ApiServer.get(commitUrl(kept, "update")).expect(200);
            res.body.value_at.should.eql(kept);
        });

        it("should get a delete commit with the deleted object", async function() {
            var res = await ApiServer.get(commitUrl(deleted, "delete")).expect(200);
            res.body.value_at.name.should.eql("deleted");
        });

        it("should not get a commit through another object", async function() {
            var other = commitUrl(deleted, "insert").replace(deleted._id, kept._id);
            await ApiServer.get(other).expect(404);
        });

        it("should not get a commit that does not exist", async function() {
            await ApiServer.get(url + "/" + kept._id + "/commits/5f0000000000000000000000").expect(404);
            await ApiServer.get(url + "/" + kept._id + "/commits/not_a_commit").expect(404);
        });

        it("should not get a revision from before the object existed", async function() {
            var before = kept._sis._created_at - 1000;
            await ApiServer.get(url + "/" + kept._id + "/revision/" + before).expect(404);
        });

        it("should get the current object for a revision in the future", async function() {
            var res = await ApiServer.get(url + "/" + kept._id + "/revision/" + (Date.now() + 100000)).expect(200);
            res.body.should.eql(kept);
        });

        describe("when history was turned on after the object was added", function() {
            var lateSchema = {
                name : "history_test_5",
                _sis : { owner : ["sistest"] },
                track_history : false,
                definition : { name : "String", n : "Number" }
            };
            var lateUrl = "/api/v1.1/entities/" + lateSchema.name;
            var late = null;

            before(async function() {
                await ApiServer.del("/api/v1.1/schemas/" + lateSchema.name);
                await ApiServer.post("/api/v1.1/schemas").send(lateSchema).expect(201);
                late = (await ApiServer.post(lateUrl).send({ name : "late", n : 1 }).expect(201)).body;
                lateSchema.track_history = true;
                await ApiServer.put("/api/v1.1/schemas/" + lateSchema.name).send(lateSchema).expect(200);
                await ApiServer.put(lateUrl + "/" + late._id).send({ n : 2 }).expect(200);
            });

            after(async function() {
                await ApiServer.del("/api/v1.1/schemas/" + lateSchema.name);
            });

            it("should not get a revision", async function() {
                await ApiServer.get(lateUrl + "/" + late._id + "/revision/" + Date.now()).expect(404);
            });

            it("should answer for an update commit", async function() {
                var list = (await ApiServer.get(lateUrl + "/" + late._id + "/commits").expect(200)).body;
                list.map(function(c) { return c.action; }).should.eql(["update"]);
                // there is no insert to apply the update to
                await ApiServer.get(lateUrl + "/" + late._id + "/commits/" + list[0]._id)
                    .timeout(5000).expect(404);
            });
        });
    });

});
