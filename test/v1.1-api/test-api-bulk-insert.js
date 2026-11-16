describe('@API @V1.1API - Bulk Insert API', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');
    var AuthFixture = require("../fixtures/authdata");

    var ApiServer = new TestUtil.TestServer();

    var schema = {
        "name":"test_bulk_entity",
        _sis : { "owner" : ["test_g1"] },
        "definition": {
            "num":   { type : "Number", unique : true, required : true }
        }
    };

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        await ApiServer.del('/api/v1.1/schemas/test_bulk_entity');
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

    // the items are start .. start + num, and each was stored with its commit
    var verifyItems = async function(start, num, items) {
        items = items.sort(function(i1, i2) {
            return i1.num - i2.num;
        });
        for (var i = start; i < (start + num); ++i) {
            items[i - start].num.should.eql(i);
        }
        var query = {
            q : getQuery(start, num)
        };
        var res = (await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .query(query)
            .expect(200)).body;
        res.should.be.instanceof(Array);
        res.length.should.eql(num);
        // ensure commits
        var verifyCommit = async function(item) {
            var path = [
                "/api/v1.1/entities",
                schema.name,
                item._id,
                "commits"
            ].join("/");
            var r = (await ApiServer.get(path).expect(200)).body;
            r.should.be.instanceof(Array);
            r.length.should.be.eql(1);
            r[0].action.should.eql("insert");
        };
        if (process.env.SIS_REMOTE_URL) {
            await Promise.all(res.map(verifyCommit));
        } else {
            for (var item of res) {
                await verifyCommit(item);
            }
        }
    };

    // the response of a bulk add with nsuccess added and nerrors failed
    var expectBulkResult = function(res, nsuccess, nerrors) {
        should.exist(res.body);
        should.exist(res.body.success);
        should.exist(res.body.errors);
        res.body.success.should.be.instanceof(Array);
        res.body.success.length.should.eql(nsuccess);
        res.body.errors.should.be.instanceof(Array);
        res.body.errors.length.should.eql(nerrors);
    };

    it("should return a 400", async function() {
        await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send([])
            .expect(400);
    });

    it("should add 200 items", async function() {
        var start = 0, num = 200;
        this.timeout(num * 1000);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        expectBulkResult(res, num, 0);
        await verifyItems(start, num, res.body.success);
    });

    it("should add 200 more items", async function() {
        var start = 1000, num = 200;
        this.timeout(num * 1000);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        expectBulkResult(res, num, 0);
        await verifyItems(start, num, res.body.success);
    });

    it("should fail to add any of the items", async function() {
        var start = 2000, num = 50;
        var items = createItems(start, num);
        items = items.concat(createItems(start, num));
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .query({ all_or_none : true })
            .send(items)
            .expect(200);
        expectBulkResult(res, 0, num);
        // ensure nothing was added in the DB
        var query = { q : getQuery(start, num) };
        res = await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .query(query)
            .expect(200);
        res.body.should.be.instanceof(Array);
        res.body.length.should.eql(0);
    });

    it("should add some of the items", async function() {
        var start = 3000, num = 50;
        var items = createItems(start, num);
        items = items.concat(createItems(start, num));
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .query({ all_or_none : false })
            .send(items)
            .expect(200);
        expectBulkResult(res, num, num);
        await verifyItems(start, num, res.body.success);
    });

    it("should report what was added when items also fail validation", async function() {
        // 3000 was added above, "abc" is not a number, 6000 is new
        var items = [{ num : 3000 }, { num : "abc" }, { num : 6000 }];
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .query({ all_or_none : false })
            .send(items)
            .expect(200);
        res.body.success.map(function(s) { return s.num; }).should.eql([6000]);
        res.body.errors.length.should.eql(2);
        res.body.errors.map(function(e) { return e.value.num; }).should.containDeep([3000]);
        await verifyItems(6000, 1, res.body.success);
    });

    describe("with Auth failures", function() {
        var users = AuthFixture.createUsers();
        var userToTokens = { };

        before(async function() {
            await AuthFixture.initUsers(ApiServer, ApiServer.authToken, users);
            await AuthFixture.createTempTokens(ApiServer, userToTokens, users);
        });

        it("should add test_g1 entities, but not test_g2", async function() {
            var start = 4000, num = 20;
            var items = createItems(start, num);
            var failStart = 5000;
            var failNum = 40;
            var failures = createItems(failStart, failNum);
            failures.forEach(function(f) {
                f._sis = { owner : ['test_g2'] };
            });
            var all = [].concat(items).concat(failures);
            var token = userToTokens.admin1.name;
            var res = await ApiServer.post("/api/v1.1/entities/" + schema.name, token)
                .query({ all_or_none : false })
                .send(all)
                .expect(200);
            res.body.success.length.should.eql(num);
            res.body.errors.length.should.eql(failNum);
            res.body.success.forEach(function(s) {
                s.num.should.be.above(start - 1);
                s.num.should.not.be.above(start + num);
            });
            res.body.errors.forEach(function(e) {
                e.value.num.should.be.above(failStart - 1);
                e.value.num.should.not.be.above(failStart + failNum);
            });
        });
    });
});
