// the async helper runs a generator that yields promises
async(function* () {
    var hosts = client.entities("test_ep_client_hosts");
    var host = yield hosts.get("h1");
    try {
        yield hosts.get("no_such_host");
    } catch (err) {
        // rejections are thrown into the generator
        return res.json({ host : host.name, missing : err[0] });
    }
    res.json({ host : host.name, missing : null });
}());
