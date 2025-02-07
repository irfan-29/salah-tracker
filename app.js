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
    date: Date,
    name: String,
    value: String
});
const Salah = mongoose.model("Salah", salahSchema);

const locationSchema = new mongoose.Schema({
    location: String
});
const Location = mongoose.model("Location", locationSchema);



app.get("/", function(req, res){
    res.render("salah", {keySalah: "", keyLocation: 1258740});
});

app.post("/salah", function(req, res){
    const date=req.body.date;
    const name=req.body.salah_name;
    const value=req.body.salah_value;
    const salah = new Salah({
        date: date,
        name: name,
        value: value
    })
    salah.save();
    res.redirect("/salah");
});

app.get("/salah", function(req, res){
    // try {
    //     const salah = await Salah.find({});
    //     res.render("salah", {keySalah: salah});
    // } catch (err) {
    //     console.log(err);
    //     res.status(500).send('Error occurred while fetching Salah');
    // }
    Salah.find({}).then((salah) => {
        res.render('salah', { keySalah: salah, keyLocation: "1258740" });
    });
});

app.post("/location", function(req, res) {
    const location = req.body.location;
    
    Location.findOneAndUpdate({}, { location: location }, { sort: { _id: -1 }, upsert: true })
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
            const prayerTimes = [];
            
            $(".d-flex.flex-direction-row").each((index, element) => {
                const timeType = $(element).find("p").first().text().trim(); // Fajr, Dhuhr, etc.
                const time = $(element).find("p").last().text().trim(); // Prayer time (e.g., 05:29 AM)
                prayerTimes.push({ timeType, time });
            });
            $("span:contains('Powered By')").remove();
            // console.log(data);
        res.render('salah-timings', { keyLocation: location!=null ? location.location : "1258740", keyPrayerTimes: prayerTimes, keyData: data });
    });
    }catch (err) {
        console.error(err);
        res.status(500).send('Error fetching prayer times.');
    }
});


app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");
});