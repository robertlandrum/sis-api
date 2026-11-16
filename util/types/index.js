import registerIpAddress from "./ipaddress.js";

// catch all
export default function(mongoose) {
    registerIpAddress(mongoose);
}
