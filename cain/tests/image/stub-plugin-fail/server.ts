// A stand-in for the Discord plugin's server whose login fails (the CI image test's
// failed-login case): the switch must undo itself.
process.stderr.write("discord channel: login failed: test\n");
process.exit(1);
