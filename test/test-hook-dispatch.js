describe("Hook Dispatch", function() {
    "use strict";

    var SIS = require("../util/constants");
    var should = require('should');
    var TestUtil = require('./fixtures/util');
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", function(done) {
        ApiServer.start(function(e) {
            if (e) { return done(e); }
            ApiServer.becomeSuperUser(done);
        });
    });

    after(function(done) {
        ApiServer.stop(done);
    });

    describe("test-get-hook-dispatch", function() {
        // the done callback that our listening server will callback on
        var doneCallback = null;
        // hook server - receives the hook events
        var hookServer = null;
        var hookHttpServer = null;
        var hookName = "test_hook_get";
        var hook = null;

        before(function(done) {
            var express = require('express');
            hookServer = express();
            // parse nested query strings (data[entity_type]=...) like Express 4 did
            hookServer.set('query parser', 'extended');
            hookServer.use(express.json());
            hookServer.get('/hook', function(req, res) {
                should.exist(req.query.data);
                var data = req.query.data;
                data.entity_type.should.eql("sis_hiera");
                data.hook.should.eql(hookName);
                data.event.should.eql(SIS.EVENT_INSERT);
                res.send("ok");
                if (doneCallback) {
                    doneCallback();
                }
            });


            var postCount = 0;
            hookServer.post('/hook_retry', function(req, res) {
                should.exist(req.body);
                if (!postCount) {
                    postCount++;
                    res.status(400).send("Need to retry.");
                } else {
                    res.status(200).send("ok");
                    if (doneCallback) {
                        doneCallback();
                    }
                }
            });

            hook = {
                "name" : hookName,
                _sis : { "owner" : ["Test"] },
                "entity_type" : "sis_hiera",
                "target" : {
                    "action" : "GET",
                    "url" : "http://127.0.0.1:3335/hook"
                },
                "events": [ SIS.EVENT_INSERT ]
            };

            hookHttpServer = hookServer.listen(3335, function(err) {
                if (err) {
                    done(err);
                }
                ApiServer.post('/api/v1.1/hooks')
                    .send(hook)
                    .expect(201, done);
            });
        });

        after(function(done) {
            hookHttpServer.close();
            ApiServer.del('/api/v1.1/hooks/' + hookName)
                .expect(200, done);
        });

        var hiera_data = {
            "name" : "hiera_key",
            _sis : { "owner" : "test" },
            "hieradata" : {
                "field" : "String",
                "field2" : "Number"
            }
        };

        it("Should dispatch the hiera hook", function(doneCb) {
            doneCallback = doneCb;
            ApiServer.post("/api/v1.1/hiera")
                .set('content-type', 'application/json')
                .send(hiera_data)
                .end(function(err, res) { });
        });

        it("Should dispatch the update hook and retry", function(doneCb) {
            doneCallback = doneCb;
            hook.target.action = "POST";
            hook.target.url = "http://127.0.0.1:3335/hook_retry";
            hook.retry_count = 5;
            hook.retry_delay = 1;
            hook.events.push(SIS.EVENT_UPDATE);
            ApiServer.put('/api/v1.1/hooks/' + hook.name)
            .send(hook).expect(200, function(err, result) {
                if (err) { console.log(err); console.log(result); return doneCb(err); }
                hiera_data.hieradata.field3 = 'foo';
                ApiServer.put("/api/v1.1/hiera/hiera_key")
                    .set('content-type', 'application/json')
                    .send(hiera_data)
                    .end(function(err, res) { });
            });
        });
    });

    describe("test-post-hook-dispatch", function() {
        // the done callback that our listening server will callback on
        var doneCallback = null;
        // hook server - receives the hook events
        var hookServer = null;
        var hookHttpServer = null;
        var hookName = "test_hook";
        var hook = null;

        before(function(done) {
            var express = require('express');
            hookServer = express();
            // parse nested query strings (data[entity_type]=...) like Express 4 did
            hookServer.set('query parser', 'extended');
            hookServer.use(express.json());
            hookServer.post('/hook', function(req, res) {
                should.exist(req.body);
                req.body.entity_type.should.eql(SIS.SCHEMA_SCHEMAS);
                req.body.hook.should.eql(hookName);
                req.body.event.should.eql(SIS.EVENT_INSERT);
                res.send("ok");
                if (doneCallback) {
                    doneCallback();
                }
            });

            hook = {
                "name" : hookName,
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : SIS.SCHEMA_SCHEMAS,
                "target" : {
                    "action" : "POST",
                    "url" : "http://127.0.0.1:3334/hook"
                },
                "events": [ SIS.EVENT_INSERT, SIS.EVENT_UPDATE ]
            };

            hookHttpServer = hookServer.listen(3334, function(err) {
                if (err) {
                    done(err);
                }
                ApiServer.post('/api/v1.1/hooks')
                    .send(hook)
                    .expect(201, done);
            });
        });

        after(function(done) {
            hookHttpServer.close();
            ApiServer.del('/api/v1.1/hooks/' + hookName)
                .expect(200, done);
        });

        var hookSchema = {
            "name" : "test",
            _sis :{ "owner" : "test" },
            "definition" : {
                "field" : "String",
                "field2" : "Number"
            }
        };

        it("Should dispatch the schema hook", function(doneCb) {
            doneCallback = doneCb;
            ApiServer.post("/api/v1.1/schemas")
                .set('content-type', 'application/json')
                .send(hookSchema)
                .end(function(err, res) { });
        });
    });

    describe("Forced Triggers", function() {
                // the done callback that our listening server will callback on
        var doneCallback = null;
        // hook server - receives the hook events
        var hookServer = null;
        var hookHttpServer = null;
        var hookName = "test_force_trigger";
        var hook = null;
        var entity = null;

        before(function(done) {
            var express = require('express');
            hookServer = express();
            // parse nested query strings (data[entity_type]=...) like Express 4 did
            hookServer.set('query parser', 'extended');
            hookServer.use(express.json());
            hookServer.post('/hook', function(req, res) {
                should.exist(req.body);
                req.body.entity_type.should.eql("test_hook_trigger");
                req.body.hook.should.eql(hookName);
                req.body.event.should.eql(SIS.EVENT_UPDATE);
                req.body.data.should.eql(req.body.old_value);
                req.body.data.should.eql(entity);
                res.send("ok");
                if (doneCallback) {
                    doneCallback();
                }
            });

            var schema = {
                name: "test_hook_trigger",
                _sis: { owner: ["sistest"] },
                definition: {
                    name: "String",
                    num: "Number"
                }
            };

            entity = {
                name: "Forced Trigger",
                num: 1001
            };

            hook = {
                "name" : hookName,
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : "test_hook_trigger",
                "target" : {
                    "action" : "POST",
                    "url" : "http://127.0.0.1:3335/hook"
                },
                "events": [ SIS.EVENT_UPDATE ]
            };

            hookHttpServer = hookServer.listen(3335, function(err) {
                if (err) {
                    done(err);
                    return;
                }

                function postCb(err, res) {
                    if (err) {
                        done(err);
                        return;
                    }
                    entity = res.body;
                    ApiServer.post('/api/v1.1/hooks')
                        .send(hook)
                        .expect(201, done);
                }

                // nuke schema
                ApiServer.del("/api/v1.1/schemas/test_hook_trigger")
                .end(function() {
                    ApiServer.post("/api/v1.1/schemas").send(schema)
                    .expect(201, function(err, res) {
                        if (err) {
                            done(err);
                            return;
                        }
                        ApiServer.post("/api/v1.1/entities/test_hook_trigger")
                        .send(entity).expect(201, postCb);
                    });
                });
            });
        });

        after(function(done) {
            hookHttpServer.close();
            ApiServer.del("/api/v1.1/schemas/test_hook_trigger")
            .expect(200, function(err, res) {
                if (err) {
                    done(err);
                    return;
                }
                ApiServer.del('/api/v1.1/hooks/' + hookName)
                    .expect(200, done);
            });
        });

        it("Should trigger the hook", function(doneCb) {
            var count = 0;
            function d(err) {
                if (err) {
                    doneCb(err);
                    return;
                }
                count++;
                if (count === 2) {
                    doneCb();
                }
            }
            doneCallback = d;
            ApiServer.post("/api/v1.1/hooks/trigger/test_hook_trigger/" + entity._id)
            .set('content-type', 'application/json')
            .expect(200, function(err, res) {
                if (err) {
                    doneCallback = null;
                    doneCb(err);
                    return;
                }
                should.exist(res.body.message);
                should.exist(res.body.type);
                res.body.type.should.eql("test_hook_trigger");
                should.exist(res.body.entity);
                res.body.entity.should.eql(entity);
                d();
            });
        });
    });

    describe("Payloads", function() {
        // what hook receivers get is a public contract - pin all of it
        var received = [];
        var hookHttpServer = null;
        var schema = {
            name : "test_hook_payloads",
            id_field : "name",
            _sis : { owner : ["sistest"] },
            definition : { name : { type : "String", required : true, unique : true }, num : "Number" }
        };
        var url = "/api/v1.1/entities/" + schema.name;
        var hooks = ["POST", "GET"].map(function(action) {
            return {
                name : "test_hook_payloads_" + action.toLowerCase(),
                _sis : { owner : ["sistest"] },
                entity_type : schema.name,
                target : { action : action, url : "http://127.0.0.1:3336/" + action.toLowerCase() },
                events : [SIS.EVENT_INSERT, SIS.EVENT_UPDATE, SIS.EVENT_DELETE]
            };
        });

        before(async function() {
            var express = require('express');
            var receiver = express();
            receiver.set('query parser', 'extended');
            receiver.use(express.json());
            receiver.post('/post', function(req, res) {
                received.push({ action : "POST", body : req.body });
                res.send("ok");
            });
            receiver.get('/get', function(req, res) {
                received.push({ action : "GET", body : req.query.data });
                res.send("ok");
            });
            await new Promise(function(resolve) { hookHttpServer = receiver.listen(3336, resolve); });
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            for (var hook of hooks) {
                await ApiServer.del("/api/v1.1/hooks/" + hook.name);
                await ApiServer.post("/api/v1.1/hooks").send(hook).expect(201);
            }
        });

        after(async function() {
            hookHttpServer.close();
            for (var hook of hooks) {
                await ApiServer.del("/api/v1.1/hooks/" + hook.name).expect(200);
            }
            await ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
        });

        // resolves with the POST and GET payloads of the next write
        async function payloadsOf(request) {
            received = [];
            var res = await request;
            for (var waited = 0; received.length < 2 && waited < 5000; waited += 20) {
                await new Promise(function(resolve) { setTimeout(resolve, 20); });
            }
            received.length.should.eql(2);
            var byAction = { };
            received.forEach(function(r) { byAction[r.action] = r.body; });
            return { res : res.body, post : byAction.POST, get : byAction.GET };
        }

        function common(payload, event, isBulk) {
            payload.hook.should.eql("test_hook_payloads_post");
            payload.entity_type.should.eql(schema.name);
            payload.event.should.eql(event);
            payload.is_bulk.should.eql(isBulk);
        }

        it("sends the added entity", async function() {
            var p = await payloadsOf(ApiServer.post(url).send({ name : "p1", num : 1 }).expect(201));
            common(p.post, SIS.EVENT_INSERT, false);
            p.post.data.should.eql(p.res);
            should.not.exist(p.post.old_value);
            JSON.parse(p.get.data).should.eql(p.res);
            p.get.event.should.eql(SIS.EVENT_INSERT);
        });

        it("sends the updated entity and the old one", async function() {
            var old = (await ApiServer.get(url + "/p1").expect(200)).body;
            var p = await payloadsOf(ApiServer.put(url + "/p1").send({ num : 2 }).expect(200));
            common(p.post, SIS.EVENT_UPDATE, false);
            p.post.data.should.eql(p.res);
            p.post.old_value.should.eql(old);
            // a GET hook gets the manager's [old, updated, null] result as JSON
            var pair = JSON.parse(p.get.data);
            pair.length.should.eql(3);
            pair[0].num.should.eql(1);
            pair[1].should.eql(p.res);
            should(pair[2]).be.null();
            should.exist(p.get.old_value);
        });

        it("sends the deleted entity", async function() {
            var p = await payloadsOf(ApiServer.del(url + "/p1").expect(200));
            common(p.post, SIS.EVENT_DELETE, false);
            p.post.data.should.eql(p.res);
            should.not.exist(p.post.old_value);
        });

        it("sends the added entities of a bulk add", async function() {
            var p = await payloadsOf(ApiServer.post(url).send([{ name : "b1", num : 1 }, { name : "b2", num : 1 }])
                                     .expect(200));
            common(p.post, SIS.EVENT_INSERT, true);
            p.post.data.map(function(e) { return e.name; }).sort().should.eql(["b1", "b2"]);
            JSON.parse(p.get.data).length.should.eql(2);
        });

        it("sends the updated entities of a bulk update", async function() {
            // only the updated entities, without the old ones
            var p = await payloadsOf(ApiServer.put(url).query({ q : JSON.stringify({ num : 1 }) })
                                     .send({ num : 5 }).expect(200));
            common(p.post, SIS.EVENT_UPDATE, true);
            p.post.data.should.eql(p.res.success);
            p.post.data.map(function(e) { return [e.name, e.num]; }).sort().should.eql([["b1", 5], ["b2", 5]]);
            should.not.exist(p.post.old_value);
        });

        it("sends the deleted entities of a bulk delete", async function() {
            var p = await payloadsOf(ApiServer.del(url).query({ q : JSON.stringify({ num : 5 }) }).expect(200));
            common(p.post, SIS.EVENT_DELETE, true);
            p.post.data.map(function(e) { return e.name; }).sort().should.eql(["b1", "b2"]);
        });
    });
});
