const passport = require("passport");
const User = require("../models/User.js");

// Field names (email/password) are configured on the plugin in models/User.js;
// createStrategy() takes no arguments in passport-local-mongoose v9.
passport.use(User.createStrategy());

// Store only the id in the session; deserializeUser rehydrates the document on
// each request.
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

// Gate for anything that writes user-specific data.
function requireLogin(req, res, next) {
  if (!req.isAuthenticated()) {
    // Remember where they were headed so login can bounce them back.
    if (req.method === "GET") {
      req.session.returnTo = req.originalUrl;
    }
    const wantsJson = req.accepts(["html", "json"]) === "json";
    if (wantsJson) return res.status(401).json({ error: "login-required" });
    return res.redirect("/login");
  }
  next();
}

// Keeps read-only pages open to everyone; nav and views need to know whether
// someone is signed in.
function attachUser(req, res, next) {
  res.locals.currentUser = req.isAuthenticated() ? req.user : null;
  next();
}

module.exports = { passport, requireLogin, attachUser };
