const express = require("express");
const bodyParser = require("body-parser");
const serverless = require("serverless-http");
const path = require("path");
const mongoose = require("mongoose");
const ejs = require("ejs");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app=express();

app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({extended: true}));
// app.use(express.static("public"));
app.use(express.static(path.join(__dirname, "../public")));
app.set("views", path.join(__dirname, "../views"));

mongoose.set({strictQuery: true});
mongoose.connect("mongodb+srv://admin-irfan:Irf6360944@cluster0.jo7etur.mongodb.net/salahDB");


const salahSchema = new mongoose.Schema({
    date: String,
    name: String,
    value: String
});
const Salah = mongoose.model("Salah", salahSchema);

const locationSchema = new mongoose.Schema({
    location: String
});
const Location = mongoose.model("Location", locationSchema);

const settingsSchema = new mongoose.Schema({
    defaultHome: String,
    location: String,
    favoriteReciter: Number,
    favoriteTranslation: String,
    lastRead: String
});
const Settings = mongoose.model("Settings", settingsSchema);

const challengesSchema = new mongoose.Schema({
    challenge: String,
    streak: Number,
    lastUpdated: String
});
const Challenges = mongoose.model("Challenges", challengesSchema);



app.get("/", async(req, res) => {
    // chnage to home (or) dashboard page later
    let defaultHome = "salah"; 
     // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.defaultHome){
            defaultHome = settings.defaultHome;
        }
    }
    res.redirect("/"+defaultHome);
});


app.get("/salah", function(req, res){
    let date = new Date(req.query.date);
    if(isNaN(date.getTime())) date = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);

    Salah.find({date: formattedDate}).then((salah) => {
        // console.log(salah);
        res.render('salah', { keyDate: formattedDate,  keySalah: salah, keyLocation: "1258740" });
    });
});



app.post("/salah", function(req, res){
    const date=new Date(req.body.date);
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);
    const name=req.body.salah_name;
    const value=req.body.salah_value;
    const salah = new Salah({
        date: formattedDate,
        name: name,
        value: value
    });
    // console.log(formattedDate);
    salah.save();
    res.redirect("/salah");
});


app.get("/quran", async(req, res) => {
    const response = await fetch(`https://quranapi.pages.dev/api/surah.json`);
    const data = await response.json();
    // console.log(data);
    let lastRead = 1;
    const settings = await Settings.findOne({});
    if (settings) {
        lastRead = settings.lastRead;
    }
    res.render("quran", {surahs: data, lastRead: lastRead});
});

app.get("/surah/:surahNo", async(req, res) => {
    const surahNo = req.params.surahNo;
    const response = await fetch(`https://quranapi.pages.dev/api/${surahNo}.json`);
    const data = await response.json();
    // default reciter is 1
    let reciter = 1; 
     // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if (settings) {
        reciter = settings.favoriteReciter;
    }
    // to update for last read
    Settings.findOneAndUpdate({}, { lastRead: surahNo }, { sort: { _id: -1 }, upsert: true })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating lsat read.");
        });
    res.render("surah", {surah: data, favoriteReciter: String(reciter)});
});


app.get("/salah-timings", async(req, res)=>{
    try{
    Location.findOne({}).then(async (location) => {
        const response = await fetch(`https://www.islamicfinder.org/prayer-widget/${location.location}/shafi/3/0/18.0/18.0`);
        const data = await response.text();

        const $ = cheerio.load(data);
        const prayerDetails = {};

        prayerDetails.location = $(".table-controller a").first().text().trim();
        prayerDetails.hijriDate = $(".table-controller div").first().text().trim();
        const today = new Date();
        const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
        const formattedDate = today.toLocaleDateString("en-US", options);
        prayerDetails.date = formattedDate;

        const prayerTimes = [];
        $(".d-flex.flex-direction-row").each((index, element) => {
            const timeType = $(element).find("p").first().text().trim();
            const time = $(element).find("p").last().text().trim();
            prayerTimes.push({ timeType, time });
        });
        prayerDetails.prayerTimes = prayerTimes;

        res.render('salah-timings', { keyLocation: location!=null ? location.location : "1258740", keyPrayerDetails: prayerDetails, keyData: data });
    });
    }catch (err) {
        console.error(err);
        res.status(500).send('Error fetching prayer times.');
    }
});


app.get("/special-days", function(req, res){
    // res.render('special-days');

    try{
        Location.findOne({}).then(async (location) => {
            const response = await fetch(`https://www.islamicfinder.org/specialislamicdays`);
            const data = await response.text();
    
            const $ = cheerio.load(data);
            const specialDays = [];

            // Loop through each row of special days
            $("#special-days-table tr").each((index, element) => {
              const month = $(element).find(".date-box .title span").text().trim();
              const day = $(element).find(".date-box .date span").text().trim();
              const event = $(element).find(".day-details h2 a").text().trim();
              const weekday = $(element).find(".day-details h4").text().split(",")[0].trim();
              const hijriDate = $(element).find(".day-details h4").text().split(",")[1].trim();
              const hijriYear = $(element).find(".day-details h4").text().split(",")[2].trim();
            
              if (month && day && event) {
                specialDays.push({
                  date: `${month} ${day}`,
                  event,
                  weekday,
                  hijriDate,
                  hijriYear,
                });
              }
            });
            
            // console.log(specialDays);
            // console.log(data);
            res.render('special-days', {specialDays});
        });
    }catch (err) {
        console.error(err);
        res.status(500).send('Error fetching prayer times.');
    }
});


app.get("/challenges", function(req, res){
    Challenges.find({}).then((challenge) => {
        res.render('challenges', {keyChallenge: challenge});
    });
    // res.render("challenges");
});

app.post("/add-challenge", function(req, res){
    const challenge = req.body.challenge;

    const newChallenge = new Challenges({
        challenge: challenge
    });
    newChallenge.save();

    // Challenges.findOneAndUpdate({}, { challenge: challenge }, { sort: { _id: -1 }, upsert: true })
    //     .then(() => {
    //         res.redirect("/settings");
    //     })
    //     .catch((err) => {
    //         console.error(err);
    //         res.status(500).send("Error adding challenge.");
    // });
    res.redirect("/settings");
});

app.post('/update-streaks', async (req, res) => {
    const completed = req.body.completed || []; // array of completed challenge IDs
    const lastUpdated = req.body.date; // get all date keys
    // console.log(completed);
    const allChallenges = await Challenges.find({});
  
    for (const challenge of allChallenges) {
      const isCompleted = completed.includes(challenge._id.toString());
  
      if (isCompleted) {
        // increment streak if completed
        challenge.streak = (challenge.streak || 0) + 1;
      } else {
        // reset if not completed
        challenge.streak = 0;
      }
  
      challenge.lastUpdated = lastUpdated; // optional: track when it was last updated
      await challenge.save();
    }
  
    res.redirect('/challenges');
  });
  

app.get("/navbar", function(req, res){
    res.render('navbar');
});


app.get("/settings", async(req, res) => {
    const response = await fetch(`https://quranapi.pages.dev/api/reciters.json`);
    const data = await response.json();
    let reciter = 1; 
    let defaultHome = "salah";
     // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.favoriteReciter)
            reciter = settings.favoriteReciter;
        if(settings.defaultHome)
            defaultHome = settings.defaultHome;
    }
    res.render('settings', {favoriteReciter: String(reciter), defaultHome: defaultHome, reciters: data});
});


app.post("/default-home", function(req,res){
    const defaultHome = req.body.defaultHome;
    Settings.findOneAndUpdate({}, { defaultHome: defaultHome }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect("/settings");
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating default home.");
    });
});


app.post("/location", function(req, res) {
    const location = req.body.location;

    //add new locations here - for support
    const locationMap = new Map([
        ["Coimbatore", "1273865"],
        ["Salem", "1257629"],
        ["Hosur", "1269934"],
        ["Ramanathapuram", "1258740"],
        ["Bengaluru", "1277333"]
    ]);
    // Location.findOneAndUpdate({}, { location: locationMap.get(location) }, { sort: { _id: -1 }, upsert: true })
    //     .then(() => {
    //         res.redirect("/salah-timings");
    //     })
    //     .catch((err) => {
    //         console.error(err);
    //         res.status(500).send("Error updating location.");
    //     });
    Settings.findOneAndUpdate({}, { location: locationMap.get(location) }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect("/salah-timings");
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating location.");
    });
});


app.post("/reciter", function(req, res){
    const reciter = req.body.reciter;

    Settings.findOneAndUpdate({}, { favoriteReciter: reciter }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect("/surah/1"); 
            // change it to last read surah index
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating location.");
        });
});


app.post("/translation", function(req, res){
    const translation = req.body.translation;

    // Settings.findOneAndUpdate({}, { favoriteReciter: reciter }, { sort: { _id: -1 }, upsert: true })
    //     .then(() => {
    //         res.redirect("/surah/1"); 
    //         // change it to last read surah index
    //     })
    //     .catch((err) => {
    //         console.error(err);
    //         res.status(500).send("Error updating location.");
    //     });
});



module.exports = app;
module.exports.handler = serverless(app);

app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");
});