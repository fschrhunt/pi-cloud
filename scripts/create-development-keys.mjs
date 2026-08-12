import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const encodedPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const encodedPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");

console.log(`export PI_CLOUD_TASK_LEASE_PRIVATE_KEY=${encodedPrivateKey}`);
console.log(`export PI_CLOUD_TASK_LEASE_PUBLIC_KEY=${encodedPublicKey}`);
