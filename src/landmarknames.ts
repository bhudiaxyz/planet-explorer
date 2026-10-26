// Per-kind sci-fi landmark name pools — each kind has 18 names, picked by (seed + instance) % 18.
export const LANDMARK_NAMES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  ring: [
    "Tycho Anomaly",    "TMA-1 Array",        "Clarke Formation",  "Sentinel Ring",
    "Obelisk Circle",   "Monolith Crown",      "Heywood Ring",      "Bowman Array",
    "Discovery Ring",   "Kubrick Gate",        "2001 Formation",    "Zagut Circle",
    "HAL Enclosure",    "Poole Circle",        "Floyd Array",       "Leonov Ring",
    "Aries Formation",  "Japetus Gate",
  ],
  spire: [
    "Arrakeen Needle",  "Barsoom Lance",       "Krypton Peak",      "Pandora Spine",
    "Nemo's Lance",     "Solaris Tip",         "Ringworld Spire",   "Terminus Peak",
    "Resonance Tower",  "Ion Spire",           "Fremen Tooth",      "Arakis Fang",
    "Giedi Pinnacle",   "Caladan Spire",       "Thumper Point",     "Maker's Hook",
    "Sardaukar Fang",   "Harkonnen Needle",
  ],
  tombs: [
    "Fallen Empire",    "Battle of Reach",     "Covenant Grounds",  "Wraith Fields",
    "Necropolis IX",    "Forerunner Relics",   "Borg Remnant",      "Dalek Memorial",
    "Zerg Hollow",      "Silent Fields",       "Helghast Ruins",    "Promethean Site",
    "Flood Graveyard",  "Precursor Burial",    "Geth Memorial",     "Collector Site",
    "Reaper Fragment",  "Prothean Tomb",
  ],
  island: [
    "Pandora Heights",  "Hallelujah Plateau",  "Laputa Station",    "Navi Eywa",
    "Starhaven Isle",   "Aether Platform",     "Skyreach",          "Bespin Platform",
    "Upper Coruscant",  "Cloud City Ruins",    "Castle in Sky",     "Sky Garden",
    "Toruk Makto",      "Kelutral Canopy",     "Iknimaya Ridge",    "Hometree Crown",
    "Orbital Gardens",  "High Sanctuary",
  ],
  arch: [
    "Stargate Prime",   "Bifrost Gate",        "Ancient Portal",    "Quantum Arch",
    "Threshold Bridge", "Event Horizon",       "Warp Gate",         "Terminus Arch",
    "Hypergate",        "Ring of Infinity",    "Pegasus Gate",      "Abydos Circle",
    "Tollan Gateway",   "Chappa'ai",           "Ori Portal",        "Asgard Bridge",
    "Quantum Mirror",   "Dakara Arch",
  ],
  ship: [
    "Nostromo Wreck",   "Sulaco Debris",       "Serenity Crash",    "Discovery One",
    "Borg Hulk",        "Star Destroyer",      "Pilgrim's Rest",    "Galactica Fragment",
    "Leviathan Down",   "Axiom Hulk",          "USCSS Wreck",       "Elysium Down",
    "Prometheus Hull",  "Covenant Hulk",       "Moya Down",         "Talyn Ruin",
    "Andromeda Ascent", "Shadow Vessel",
  ],
  pillars: [
    "Magrathea Columns","Krypton Crystals",    "Ringworld Spires",  "Arrakis Pillars",
    "Solaris Obelisks", "Terminus Posts",      "Helicon Shafts",    "Ion Crystals",
    "Resonance Field",  "Anomaly Pillars",     "Monolith Shards",   "Basalt Crown",
    "Forerunner Posts", "Prothean Pylons",     "Sangheili Columns", "Covenant Spires",
    "Ancient Conduit",  "Precursor Lattice",
  ],
  crater: [
    "Chicxulub",        "Vredefort Basin",     "Sudbury Hollow",    "Tunguska Point",
    "Meteor Scar",      "Ceres Impact",        "Vesta Pit",         "Callisto Basin",
    "Phobos Crater",    "Titan Depression",    "Manicouagan Ring",  "Clearwater Basin",
    "Acraman Hollow",   "Siljan Ring",         "Popigai Basin",     "Chesapeake Rim",
    "Kara Hollow",      "Mjolnir Scar",
  ],
};

// Flat name pool used by findSpots() to label scanned terrain features (beaches, canyons, etc.)
export const SPOT_NAMES: readonly string[] = [
  // Dune / Foundation / Vorkosigan
  "Arrakeen","Giedi Prime","Caladan","Salusa Secundus",
  "Trantor","Helicon","Terminus","Askonia","Kalgan",
  "Komarr","Barrayar","Athos","Sigma Draconis","Aral",
  // Stanislaw Lem
  "Solaris","Rheya","Kelvin Station","Harey",
  // Alien / Hitchhiker's
  "LV-426","Fiorina 161","Hadley's Hope",
  "Magrathea","Betelgeuse VII","Krikkit","Vogsphere",
  // BSG / Avatar / Marvel
  "Caprica","Picon","Scorpia","Gemenon","Kobol",
  "Pandora","Hell's Gate","Iknimaya","Kelutral",
  "Ego","Contraxia","Knowhere","Sovereign","Sakaar",
  // Star Wars
  "Tatooine","Hoth","Bespin","Endor","Coruscant",
  // Halo / Mass Effect
  "Reach","Threshold","Installation 04","Harvest","Meridian",
  "Rannoch","Palaven","Tuchanka","Thessia","Eden Prime",
  "Gilevane","Irune","Sur'Kesh","Dekuuna",
  // Hyperion / Ringworld
  "Hyperion","Pacem","Hebron","Tau Ceti Center","Lusus",
  "Ringworld","Fist of God","Arch","Spill Mountain",
  // Galaxies
  "Andromeda","Triangulum","Whirlpool","Sombrero","Cartwheel",
  "Pinwheel","Sunflower","Sculptor","Centaurus A","Bode's Galaxy",
  "Large Magellanic","Small Magellanic","Black Eye","Tadpole","Antennae",
  // Nebulae
  "Orion Nebula","Crab Nebula","Eagle Nebula","Helix Nebula","Ring Nebula",
  "Horsehead","Pillars of Creation","Lagoon Nebula","Veil Nebula","Carina Nebula",
  "Rosette","Tarantula","Butterfly Nebula","Cat's Eye","Owl Nebula",
  "Flame Nebula","Pelican Nebula","Witch Head","Running Man","Soul Nebula",
  // Culture ships
  "Sleeper Service","Mistake Not","Quietly Confident","Just Read the Instructions",
  "Experiencing A Significant Gravitas Shortfall","Lightly Seared on the Reality Grill",
  // Revelation Space / Le Guin / The Expanse / Babylon 5
  "Chasm City","Resurgam","Ararat","Hela","Absolution Gap",
  "Anarres","Urras","Gethen","Rocannon's World","Athshe",
  "Ilus","Laconia","Medina","Ring Station",
  "Minbar","Narn","Centauri Prime","Z'ha'dum","Rigel VII",
  // US National Parks
  "Yellowstone","Yosemite","Grand Canyon","Zion","Bryce Canyon",
  "Arches","Canyonlands","Capitol Reef","Badlands","Grand Teton",
  "Olympic","Rainier","Crater Lake","Denali","Kenai Fjords",
  "Sequoia","Joshua Tree","Death Valley","Saguaro","Petrified Forest",
  "Acadia","Everglades","Biscayne","Dry Tortugas","Shenandoah",
  "Great Smoky","Mammoth Cave","Isle Royale","Sleeping Bear","Voyageurs",
  "Glacier","Waterton","Rocky Mountain","Mesa Verde","Black Canyon",
  // World parks
  "Banff","Jasper","Algonquin","Nahanni","Kluane",
  "Torres del Paine","Iguazú","Pantanal","Galápagos","Patagonia",
  "Fiordland","Abel Tasman","Tongariro","Purnululu","Kakadu",
  "Serengeti","Ngorongoro","Virunga","Okavango","Etosha",
  "Kruger","Bwindi","Simien","Tsavo","Amboseli",
  "Sagarmatha","Kaziranga","Sundarbans","Ranthambore","Nagarhole",
  "Jiuzhaigou","Zhangjiajie","Huangshan","Wulingyuan","Changbai",
  "Plitvice","Durmitor","Triglav","Białowieża","Ordesa",
  "Doñana","Skellig Michael","Cairngorms","Snowdonia","Dartmoor",
  // Terrain-flavoured
  "Obsidian Flats","Ashfall Plain","Midnight Basin","Ironspire","Cinder Reach",
  "The Shallows","High Ridge","Storm Coast","Dust Bowl","Caldera",
  "The Rift","Sunken Vale","Mountain Peak","Coastal Cliffs","Ancient Shelf",
];
