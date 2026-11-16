describe('@API @V1.1API - Bulk Update API', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');
    var AuthFixture = require("../fixtures/authdata");

    var ApiServer = new TestUtil.TestServer();

    var schema = {
        "name":"test_bulk_update_entity",
        _sis : { "owner" : ["test_g1"] },
        "definition": {
            "str" : "String",
            "num":   { type : "Number", unique : true, required : true }
        }
    };

    var createItems = function(start, num) {
        var result = [];
        for (var i = start; i < (start + num); ++i) {
            result.push({ num: i, str : "s_" + i });
        }
        return result;
    };


    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        await ApiServer.del('/api/v1.1/schemas/test_bulk_update_entity');
        await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
    });

    // the response of a bulk operation where num succeeded and none failed
    var expectAllSucceeded = function(res, num) {
        should.exist(res.body);
        should.exist(res.body.success);
        should.exist(res.body.errors);
        res.body.success.should.be.instanceof(Array);
        res.body.success.length.should.eql(num);
        res.body.errors.should.be.instanceof(Array);
        res.body.errors.length.should.eql(0);
    };

    it("should add 200 items", async function() {
        var start = 0, num = 200;
        this.timeout(num * 1000);
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name)
            .send(createItems(start, num))
            .expect(200);
        expectAllSucceeded(res, num);
    });


    after(async function() {
        await ApiServer.stop();
    });

    // the items are start .. start + num, match q, and were updated once
    var verifyItems = async function(start, num, items, q) {
        items = items.sort(function(i1, i2) {
            return i1.num - i2.num;
        });
        for (var i = start; i < (start + num); ++i) {
            items[i - start].num.should.eql(i);
        }
        var query = {
            q : q
        };
        var res = (await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .query(query)
            .expect(200)).body;
        res.should.be.instanceof(Array);
        res.length.should.eql(num);
        // ensure commits
        var verifyCommits = async function(item) {
            var path = [
                "/api/v1.1/entities",
                schema.name,
                item._id,
                "commits"
            ].join("/");
            var r = (await ApiServer.get(path).expect(200)).body;
            r.should.be.instanceof(Array);
            r.length.should.eql(2);
            r[0].action.should.eql("update");
        };
        if (process.env.SIS_REMOTE_URL) {
            await Promise.all(res.map(verifyCommits));
        } else {
            for (var item of res) {
                await verifyCommits(item);
            }
        }
    };

    it("should return a 400 with empty array", async function() {
        await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .send([])
            .expect(400);
    });

    it("should return a 400 with empty body", async function() {
        await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .query({ q : { num : 1 }})
            .send({})
            .expect(400);
    });

    it("should return a 400 with non array or body", async function() {
        await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .query({ q : { num : 1 }})
            .send("bad")
            .expect(400);
    });

    it("should return a 400 with empty query", async function() {
        await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .send({ str : "should fail" })
            .expect(400);
    });

    var getQuery = function(start, num) {
        return {
            num : {
                $gte : start,
                $lt : (start + num)
            }
        };
    };

    it("should update items 0-99", async function() {
        var start = 0, num = 100;
        var query = getQuery(start, num);
        this.timeout(num * 1000);
        var res = await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .send({ str : "bulk_update" })
            .query({ q : query })
            .expect(200);
        expectAllSucceeded(res, num);
        res.body.success.forEach(function(item) {
            should.exist(item.str);
            item.str.should.eql("bulk_update");
        });
        await verifyItems(start, num, res.body.success, query);
    });

    it("should update items 100-149", async function() {
        var start = 100, num = 50;
        var query = getQuery(start, num);
        this.timeout(num * 1000);
        // fetch them
        var res = await ApiServer.get("/api/v1.1/entities/" + schema.name)
            .query({q : query })
            .expect(200);
        res.body.should.be.instanceof(Array);
        res.body.length.should.eql(num);
        var updateItems = res.body.map(function(i) {
            return {
                _id : i._id,
                str : "bu_" + (i.num * 2)
            };
        });
        // send it up
        res = await ApiServer.put("/api/v1.1/entities/" + schema.name)
            .send(updateItems)
            .expect(200);
        expectAllSucceeded(res, num);
        res.body.success.forEach(function(item) {
            should.exist(item.str);
            var expected = "bu_" + (item.num * 2);
            item.str.should.eql(expected);
        });
        await verifyItems(start, num, res.body.success, query);
    });

});
