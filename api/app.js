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



// Schemas

const salahSchema = new mongoose.Schema({
    date: String,
    name: String,
    value: String
});
const Salah = mongoose.model("Salah", salahSchema);

const challengesSchema = new mongoose.Schema({
    challenge: String,
    currentStreak: Number,
    maxStreak: Number,
    lastUpdated: String
});
const Challenges = mongoose.model("Challenges", challengesSchema);

const settingsSchema = new mongoose.Schema({
    defaultHome: String,
    location: String,
    favoriteReciter: Number,
    favoriteEdition: String,
    lastRead: String
});
const Settings = mongoose.model("Settings", settingsSchema);



// global constants

//add new locations here - for support
const locationMap = new Map([
    ["Coimbatore", "1273865"],
    ["Salem", "1257629"],
    ["Hosur", "1269934"],
    ["Ramanathapuram", "1258740"],
    ["Bengaluru", "1277333"]
]);



// GET methods

app.get("/", async (req, res) => {
    // chnage to home (or) dashboard page later
    let defaultHome = "salah";
    // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if(settings){
        if(settings.defaultHome)
            defaultHome = settings.defaultHome;
    }
    res.redirect("/" + defaultHome);
});


app.get("/quran", async(req, res) => {
    const response = await fetch(`https://quranapi.pages.dev/api/surah.json`);
    const data = await response.json();

    let lastRead = 1;
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.lastRead)
            lastRead = settings.lastRead;
    }
    res.render("quran", {surahs: data, lastRead: lastRead});
});


app.get("/surah/:surahNo", async(req, res) => {
    // default reciter is 1
    let reciter = 1;
    // default edition is null 
    let favoriteEdition = "";
     // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.favoriteReciter)
            reciter = settings.favoriteReciter;
        if(settings.favoriteEdition)
            favoriteEdition = settings.favoriteEdition;
    }
    favoriteEdition = favoriteEdition.replace(/\s*\(.*?\)\s*$/, '');

    const surahNo = req.params.surahNo;
    const response = await fetch(`https://quranapi.pages.dev/api/${surahNo}.json`);
    const data = await response.json();
    let translationJson = {};
    if(favoriteEdition != ""){
        const translation = await fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${favoriteEdition}/${surahNo}.json`);
        translationJson = await translation.json();
    }

    // to update for last read
    Settings.findOneAndUpdate({}, { lastRead: surahNo }, { sort: { _id: -1 }, upsert: true })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating lsat read.");
        });
    res.render("surah", {surah: data, translation: translationJson, favoriteReciter: String(reciter), lastRead: surahNo});
});


app.get("/salah", function(req, res){
    let date = new Date(req.query.date);
    if(isNaN(date.getTime())) date = new Date();
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = date.toLocaleDateString("en-US", options);

    Salah.find({date: formattedDate}).then((salah) => {
        res.render('salah', { keyDate: formattedDate,  keySalah: salah });
    });
});


app.get("/salah-timings", async(req, res)=>{
    let location = "Coimbatore";
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.location)
            location = settings.location;
    }

    const response = await fetch(`https://www.islamicfinder.org/prayer-widget/${locationMap.get(location)}/shafi/3/0/18.0/18.0`);
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

    res.render('salah-timings', { location: location, keyPrayerDetails: prayerDetails, keyData: data });
});


// Helper function to get current Hijri date
async function getCurrentHijriDate() {
    const response = await fetch('https://api.aladhan.com/v1/gToH');
    const data = await response.json();
    return {
      hijriMonth: parseInt(data.data.hijri.month.number),
      hijriYear: parseInt(data.data.hijri.year),
    };
  }



  app.get('/calendar', async (req, res) => {
    const hijriMonth = parseInt(req.query.month) || 1;
    const year = parseInt(req.query.year) || 1446;

    const apiUrl = `https://api.aladhan.com/v1/hToGCalendar/${hijriMonth}/${year}`;
    const response = await fetch(apiUrl);
    const json = await response.json();
    console.log(json);

    const hijriMonthName = json.data[0].hijri.month.en;
    const gregorianMonth = json.data[0].gregorian.month.en;
    const gregorianYear = json.data[0].gregorian.year;

    // Map dates into weeks
    const days = json.data.map(d => ({
        hijri: d.hijri.day,
        gregorian: d.gregorian.day,
        weekday: d.gregorian.weekday.en,
        date: d.gregorian.date,
        fullHijri: `${d.hijri.day} ${d.hijri.month.en} ${d.hijri.year}`,
    }));

    let firstValidDate = json.data.find(d => d && d.gregorian && d.gregorian.date);
    let firstWeekday = 0;
    
    if (firstValidDate) {
        const date = new Date(firstValidDate.gregorian.date);
        firstWeekday = isNaN(date.getDay()) ? 0 : date.getDay();
    }

const paddedDays = Array(firstWeekday).fill(null).concat(days);


    const weeks = [];
    for (let i = 0; i < paddedDays.length; i += 7) {
        weeks.push(paddedDays.slice(i, i + 7));
    }

    res.render('special-days', {
        hijriMonthName,
        hijriMonth,
        year,
        gregorianMonth,
        gregorianYear,
        weeks
    });
});




app.get("/special-days", async(req, res) => {
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
        res.render('special-days', {calendarData: "", specialDays});
    });
});


app.get("/challenges", function(req, res){
    Challenges.find({}).then((challenge) => {
        res.render('challenges', {keyChallenge: challenge});
    });
});
  

app.get("/settings", async(req, res) => {
    const reciters = await fetch(`https://quranapi.pages.dev/api/reciters.json`);
    const edition = await fetch('https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json');

    const recitersJson = await reciters.json();
    const editionsJson = await edition.json();
    let reciter = 1; 
    let defaultHome = "salah";
    let location = "Coimbatore";
    let favoriteEdition = "";
     // wait for settings to be fetched
    const settings = await Settings.findOne({});
    if (settings) {
        if(settings.favoriteReciter)
            reciter = settings.favoriteReciter;
        if(settings.defaultHome)
            defaultHome = settings.defaultHome;
        if(settings.location)
            location = settings.location;
        if(settings.favoriteEdition)
            favoriteEdition = settings.favoriteEdition;
    }
    // Group by language
    const editionsByLanguage = {};
    for (let key in editionsJson) {
      const edition = editionsJson[key];
      const lang = edition.language || "Unknown";
      if (!editionsByLanguage[lang]) editionsByLanguage[lang] = [];
      editionsByLanguage[lang].push({
        name: edition.name,
        author: edition.author
      });
    }
    res.render('settings', {favoriteReciter: String(reciter), favoriteEdition: favoriteEdition, defaultHome: defaultHome, location: location, reciters: recitersJson, editions: editionsByLanguage});
});







// POST methods

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
    salah.save();
    res.redirect("/salah");
});


app.post("/add-challenge", function(req, res){
    const challenge = req.body.challenge;
    const newChallenge = new Challenges({
        challenge: challenge
    });
    newChallenge.save();
    res.redirect("/settings");
});


app.post('/update-streaks', async (req, res) => {
    const completed = req.body.completed || []; // array of completed challenge IDs
    const lastUpdated=new Date(req.body.date);
    const options = { weekday: "long", month: "short", day: "2-digit", year: "numeric" };
    const formattedDate = lastUpdated.toLocaleDateString("en-US", options);

    const allChallenges = await Challenges.find({});
  
    for (const challenge of allChallenges) {
      const isCompleted = completed.includes(challenge._id.toString());
  
      if (isCompleted) {
        // increment streak if completed
        challenge.currentStreak = (challenge.currentStreak || 0) + 1;

        if(challenge.currentStreak > (challenge.maxStreak || 0)) {
            challenge.maxStreak = challenge.currentStreak;
        }
      } else {
        // reset if not completed
        challenge.currentStreak = 0;
      }
  
      challenge.lastUpdated = formattedDate; // optional: track when it was last updated
      await challenge.save();
    }
  
    res.redirect('/challenges');
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
    const redirectTo = req.body.redirectTo;

    Settings.findOneAndUpdate({}, { location: location }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect(redirectTo);
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating location.");
    });
});


app.post("/reciter", function(req, res){
    const reciter = req.body.reciter;
    const redirectTo = req.body.redirectTo;

    Settings.findOneAndUpdate({}, { favoriteReciter: reciter }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect(redirectTo);
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating reciter.");
        });
});

app.post("/set-edition", function(req, res){
    const selectedEdition = req.body.edition;

    Settings.findOneAndUpdate({}, { favoriteEdition: selectedEdition }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect("/settings"); 
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating Edition.");
        });
  });



module.exports = app;
module.exports.handler = serverless(app);

app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");
});