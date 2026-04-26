// ✅ Force IPv4 - fixes Auth0 DNS timeout
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const ejsMate = require('ejs-mate');
const methodOverride = require('method-override');
const session = require('express-session');
const flash = require('connect-flash');
const { auth } = require('express-openid-connect');

const User = require('./models/user');
const { isAuthenticated, loginHandler } = require('./middleware/auth-middleware');
const userRoutes = require('./routes/users');
const campgroundRoutes = require('./routes/campgrounds');
const reviewRoutes = require('./routes/reviews');
const ExpressError = require('./utils/ExpressError');

const app = express();

// =====================
// DATABASE CONNECTION
// =====================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27018/yelp-camp');
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'Connection error:'));
db.once('open', () => {
    console.log('✅ MongoDB connected');
});

// =====================
// VIEW ENGINE
// =====================
app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// =====================
// MIDDLEWARE
// =====================
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// =====================
// SESSION
// =====================
app.use(session({
    name: 'yelp-session',
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

app.use(flash());

// =====================
// AUTH0
// =====================
app.use(auth({
    authRequired: false,
    auth0Logout: true,
    idpLogout: false,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    baseURL: process.env.AUTH0_BASE_URL || 'http://localhost:3000',
    clientID: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    secret: process.env.AUTH0_SECRET,
    authorizationParams: {
        response_type: 'code',
        scope: 'openid profile email'
    },
    routes: {
        callback: '/callback',
        postLogoutRedirect: '/'
    },
    session: {
        absoluteDuration: 60 * 60 * 24 * 7,
        rolling: true,
        rollingDuration: 60 * 60 * 24
    },
    clockTolerance:  3600,
    httpTimeout: 10000
}));

// =====================
// LOCALS + USER SYNC
// =====================
app.use(async (req, res, next) => {
    try {
        if (req.oidc.isAuthenticated()) {
            const { sub, email, name, nickname } = req.oidc.user;
            let user = await User.findOne({ auth0Id: sub });
            if (!user) {
                user = new User({
                    auth0Id: sub,
                    email,
                    username: name || nickname || email.split('@')[0]
                });
                await user.save();
                console.log('✅ New user created:', user.username);
            } else if (user.username !== (name || nickname || email.split('@')[0])) {
                user.username = name || nickname || email.split('@')[0];
                await user.save();
            }
            req.session.userId = user._id;
            res.locals.currentUser = user;
            res.locals.currentUserName = user.username;
        } else {
            res.locals.currentUser = null;
            res.locals.currentUserName = null;
        }
    } catch (err) {
        console.error('❌ User sync error:', err);
        res.locals.currentUser = null;
        res.locals.currentUserName = null;
    }

    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.mapBoxToken = process.env.MAPBOX_TOKEN;
    next();
});

// =====================
// AUTH ROUTES
// =====================
app.get('/login', loginHandler);

app.get('/logout', (req, res) => {
    res.oidc.logout({
        returnTo: process.env.AUTH0_BASE_URL || 'http://localhost:3000'
    });
});

// =====================
// APP ROUTES
// =====================
app.get('/', (req, res) => res.render('home'));
app.use('/', userRoutes);
app.use('/campgrounds', campgroundRoutes);
app.use('/campgrounds/:id/reviews', reviewRoutes);

// =====================
// ERROR HANDLING
// =====================
app.all('*', (req, res, next) => {
    next(new ExpressError('Page Not Found', 404));
});

// Auth0 errors
app.use((err, req, res, next) => {
    if (err.status === 400) {
        console.log('🔄 Auth0 400 error:', err.message);
        res.clearCookie('appSession');
        res.clearCookie('auth_verification');
        return res.redirect('/');
    }
    next(err);
});

// Generic error handler
app.use((err, req, res, next) => {
    const { statusCode = 500, message = 'Something went wrong' } = err;
    res.status(statusCode).render('error', { statusCode, message, err });
});

// =====================
// SERVER
// =====================

if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`🚀 Server running at http://localhost:${port}`);
    });
}

module.exports = app;
