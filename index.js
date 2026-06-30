const express = require('express');
const app = express();
const port = process.env.PORT || 8000;
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path'); // Ye line add karein

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Ye line add karein taake website file load ho sake
app.use(express.static(path.join(__dirname, 'public'))); 

// Agar aapki index.html file root mein hai to ye use karein
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const pairRouter = require('./main');
app.use('/', pairRouter);

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

module.exports = app;

