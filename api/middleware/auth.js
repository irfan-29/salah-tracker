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
    // Remember where they were headed, so the SPA can return the user there
    // after sign-in instead of dropping them on the home page.
    if (req.method === "GET") {
      req.session.returnTo = req.originalUrl;
    }
    // Always 401 JSON. This branch used to content-negotiate and redirect to
    // /login, which was right when every route rendered HTML. The backend is
    // API-only now, and a 302 there is worse than useless: a fetch() follows it
    // and receives the SPA's index.html, so the caller sees HTML where it
    // expected JSON and reports a parse error instead of "sign in first".
    return res.status(401).json({ error: "login-required" });
  }
  next();
}

// attachUser was removed with the EJS layer. It existed only to set
// res.locals.currentUser for the server-rendered templates; the JSON API reads
// req.user, which passport populates via passport.session().

module.exports = { passport, requireLogin };
