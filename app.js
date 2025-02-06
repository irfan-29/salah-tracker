const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const ejs = require("ejs");

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



app.get("/", function(req, res){
    res.render("salah", {keySalah: ""});
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
        res.render('salah', { keySalah: salah });
    });
});


app.listen(process.env.PORT || 3000, function(){
    console.log("Server is running on port 3000");
});