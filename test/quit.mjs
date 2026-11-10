// Close the test Chrome started by test/launch.sh.
import { CDP, PORT } from './cdp.mjs';
const cdp = await CDP.connect(PORT);
await cdp.send('Browser.close').catch(() => {});
cdp.close();
