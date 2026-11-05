// Official release binaries do not contain the independent collection contract.
import { prepareQuotaSidecar } from "./quota-collector/build.mjs";

await prepareQuotaSidecar();
