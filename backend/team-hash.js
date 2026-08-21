// Turn a password into the TEAM_PASSWORD_HASH value: npm run team:hash -- "<password>"
//
// Exists so the password is never typed into a file that git can see. The hash
// is safe to store; the password is not, and this repository is public.
import { hashPassword } from "./teamAuth.js";

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run team:hash -- "<password>"');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Use at least 8 characters.");
  process.exit(1);
}
console.log("\nPut these two lines in .env (never in a committed file):\n");
console.log("TEAM_EMAIL=<the sign-in email>");
console.log("TEAM_PASSWORD_HASH=" + (await hashPassword(password)));
console.log("");
