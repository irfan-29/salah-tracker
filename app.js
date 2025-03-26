const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const ejs = require("ejs");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app=express();

app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static("public"));

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



app.get("/", function(req, res){
    res.redirect("/salah");
    // res.render("salah", {keyDate: "", keySalah: "", keyLocation: 1258740});
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
    Location.findOneAndUpdate({}, { location: locationMap.get(location) }, { sort: { _id: -1 }, upsert: true })
        .then(() => {
            res.redirect("/salah-timings");
        })
        .catch((err) => {
            console.error(err);
            res.status(500).send("Error updating location.");
        });
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
        console.log($);
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

app.get("/navbar", function(req, res){
    res.render('navbar');
});

app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");
});