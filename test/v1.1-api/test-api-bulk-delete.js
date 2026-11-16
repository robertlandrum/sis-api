describe('@API @V1.1API - Bulk Delete API', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');
    var AuthFixture = require("../fixtures/authdata");

    var ApiServer = new TestUtil.TestServer();

    var schema = {
        "name":"test_bulk_del_entity",
        _sis : { "owner" : ["test_g1", "test_g2"] },
        "definition": {
            "num":   { type : "Number", unique : true, required : true }
        }
    };

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        await ApiServer.del('/api/v1.1/schemas/test_bulk_del_entity');
        await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
    });

    after(async function() {
        await ApiServer.stop();
    });

    var getQuery = function(start, num) {
        return {
            num : {
                $gte : start,
                $lt : (start + num)
            }
        };
    };

    var createItems = function(start, num) {
        var result = [];
        for (var i = start; i < (start + num); ++i) {
            result.push({ num: i });
        }
        return result;
    };

    // the items are gone, and their commits are the insert and the delete
    var verifyDeletedItems = async function(items) {
        var verify = async function(item) {
            var parts = [
                "/api/v1.1/entities",
                schema.name,
                item._id
            ];
            await ApiServer.get(parts.join("/")).expect(404);
            // commits
            parts.push("commits");
            var r = (await ApiServer.get(parts.join("/")).expect(200)).body;
            r.should.be.instanceof(Array);
            r.length.should.be.eql(2);
            r[1].action.should.eql("insert");
            r[0].action.should.eql("delete");
        };
        if (process.env.SIS_REMOTE_URL) {
            await Promise.all(items.map(verify));
        } else {
            for (var item of items) {
                await verify(item);
            }
        }
    };

    it("should return a 400", async function() {
        var start = 0, num = 50;
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        res.body.success.length.should.eql(num);
        await ApiServer.del("/api/v1.1/entities/" + schema.name)
            .expect(400);
    });

    it("should delete 150 items", async function() {
        var start = 1000, num = 150;
        this.timeout(num * 1000);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        res.body.success.length.should.eql(num);
        // delete all of them
        var query = { q : getQuery(start, num) };
        res = await ApiServer.del("/api/v1.1/entities/" + schema.name)
            .query(query)
            .expect(200);
        should.exist(res.body.success);
        should.exist(res.body.errors);
        res.body.success.should.be.instanceof(Array);
        res.body.success.length.should.be.eql(num);
        await verifyDeletedItems(res.body.success);
    });

    it("should delete even items", async function() {
        var start = 2000, num = 150;
        this.timeout(num * 1000);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        res.body.success.length.should.eql(num);
        // delete all of them
        var query = {
            q : {
                num : { $mod : [2, 0],
                        $gte : start,
                        $lt : (start + num)
                      }
            }
        };
        res = await ApiServer.del("/api/v1.1/entities/" + schema.name)
            .query(query)
            .expect(200);
        res.body.success.should.be.instanceof(Array);
        res.body.success.length.should.be.eql(num / 2);
        await verifyDeletedItems(res.body.success);
    });

    describe("with Auth failures", function() {
        var users = AuthFixture.createUsers();
        var userToTokens = { };

        before(async function() {
            await AuthFixture.initUsers(ApiServer, ApiServer.authToken, users);
            await AuthFixture.createTempTokens(ApiServer, userToTokens, users);
        });

        it("should delete test_g1 entities, but not test_g2", async function() {
            var start = 4000, num = 20;
            var items = createItems(start, num);
            var failStart = 5000;
            var failNum = 40;
            var failures = createItems(failStart, failNum);
            failures.forEach(function(f) {
                f._sis = { owner : ['test_g2'] };
            });
            var all = [].concat(items).concat(failures);
            // add as super
            this.timeout(num * 1000);
            var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .send(all)
                .expect(200);
            res.body.success.length.should.eql(all.length);
            // delete all as admin1
            var query = {
                q : { num : { $gte : start } }
            };
            var token = userToTokens.admin1.name;
            res = await ApiServer.del("/api/v1.1/entities/" + schema.name, token)
                .query(query)
                .expect(200);
            res.body.success.length.should.eql(num);
            res.body.errors.length.should.eql(failNum);
            await verifyDeletedItems(res.body.success);
        });
    });
});
