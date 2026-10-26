// All procedural name pools in one place.
// Landmark names are picked by (seed + instance) % pool.length per kind.
// River names are picked by Math.abs(seed + index × 7) % RIVER_NAMES.length.
// Spot names are picked by a seeded offset into SPOT_NAMES.

// ---- Landmark names -----------------------------------------------------------

// Per-kind sci-fi name pools — each kind has 18 names.
export const LANDMARK_NAMES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  // Theme: 2001: A Space Odyssey — monoliths, crew, ships, and discovery sites
  ring: [
    "Tycho Anomaly",    "TMA-1 Array",        "Clarke Formation",  "Sentinel Ring",
    "Obelisk Circle",   "Monolith Crown",      "Heywood Ring",      "Bowman Array",
    "Discovery Ring",   "Kubrick Gate",        "2001 Formation",    "Zagut Circle",
    "HAL Enclosure",    "Poole Circle",        "Floyd Array",       "Leonov Ring",
    "Aries Formation",  "Japetus Gate",
  ],
  // Theme: Dune (Arrakis/Barsoom) — spice world geography, fremen culture, Harkonnen military
  spire: [
    "Arrakeen Needle",  "Barsoom Lance",       "Krypton Peak",      "Pandora Spine",
    "Nemo's Lance",     "Solaris Tip",         "Ringworld Spire",   "Terminus Peak",
    "Resonance Tower",  "Ion Spire",           "Fremen Tooth",      "Arakis Fang",
    "Giedi Pinnacle",   "Caladan Spire",       "Thumper Point",     "Maker's Hook",
    "Sardaukar Fang",   "Harkonnen Needle",
  ],
  // Theme: Video game battlefields — Halo, Mass Effect, StarCraft, Killzone, Doctor Who
  tombs: [
    "Fallen Empire",    "Battle of Reach",     "Covenant Grounds",  "Wraith Fields",
    "Necropolis IX",    "Forerunner Relics",   "Borg Remnant",      "Dalek Memorial",
    "Zerg Hollow",      "Silent Fields",       "Helghast Ruins",    "Promethean Site",
    "Flood Graveyard",  "Precursor Burial",    "Geth Memorial",     "Collector Site",
    "Reaper Fragment",  "Prothean Tomb",
  ],
  // Theme: Avatar / Laputa / Star Wars sky cities — floating platforms and canopy settlements
  island: [
    "Pandora Heights",  "Hallelujah Plateau",  "Laputa Station",    "Navi Eywa",
    "Starhaven Isle",   "Aether Platform",     "Skyreach",          "Bespin Platform",
    "Upper Coruscant",  "Cloud City Ruins",    "Castle in Sky",     "Sky Garden",
    "Toruk Makto",      "Kelutral Canopy",     "Iknimaya Ridge",    "Hometree Crown",
    "Orbital Gardens",  "High Sanctuary",
  ],
  // Theme: Stargate SG-1 / Norse mythology — wormhole gates, Asgard bridges, ancient portals
  arch: [
    "Stargate Prime",   "Bifrost Gate",        "Ancient Portal",    "Quantum Arch",
    "Threshold Bridge", "Event Horizon",       "Warp Gate",         "Terminus Arch",
    "Hypergate",        "Ring of Infinity",    "Pegasus Gate",      "Abydos Circle",
    "Tollan Gateway",   "Chappa'ai",           "Ori Portal",        "Asgard Bridge",
    "Quantum Mirror",   "Dakara Arch",
  ],
  // Theme: Famous fictional spacecraft wrecks — Alien, Firefly, BSG, WALL-E, Farscape
  ship: [
    "Nostromo Wreck",   "Sulaco Debris",       "Serenity Crash",    "Discovery One",
    "Borg Hulk",        "Star Destroyer",      "Pilgrim's Rest",    "Galactica Fragment",
    "Leviathan Down",   "Axiom Hulk",          "USCSS Wreck",       "Elysium Down",
    "Prometheus Hull",  "Covenant Hulk",       "Moya Down",         "Talyn Ruin",
    "Andromeda Ascent", "Shadow Vessel",
  ],
  // Theme: Hitchhiker's Guide / Dune / Halo / Mass Effect geology and megastructures
  pillars: [
    "Magrathea Columns","Krypton Crystals",    "Scrith Columns",    "Arrakis Pillars",
    "Solaris Obelisks", "Terminus Posts",      "Helicon Shafts",    "Ion Crystals",
    "Resonance Field",  "Anomaly Pillars",     "Monolith Shards",   "Basalt Crown",
    "Forerunner Posts", "Prothean Pylons",     "Sangheili Columns", "Covenant Spires",
    "Ancient Conduit",  "Precursor Lattice",
  ],
  // Theme: Real impact craters (Earth/solar system) + Thor mythology (Mjolnir)
  crater: [
    "Chicxulub",        "Vredefort Basin",     "Sudbury Hollow",    "Tunguska Point",
    "Meteor Scar",      "Ceres Impact",        "Vesta Pit",         "Callisto Basin",
    "Phobos Crater",    "Titan Depression",    "Manicouagan Ring",  "Clearwater Basin",
    "Acraman Hollow",   "Siljan Ring",         "Popigai Basin",     "Chesapeake Rim",
    "Kara Hollow",      "Mjolnir Scar",
  ],
};

// ---- River names --------------------------------------------------------------

// Sci-fi themed, picked by Math.abs(seed + index × 7) % RIVER_NAMES.length.
export const RIVER_NAMES: readonly string[] = [
  // Greek/Roman underworld rivers — Hyperion Cantos, classic sci-fi mythology
  "Acheron",        "Styx",           "Lethe",          "Phlegethon",     "Eridanus",
  "Charon Flow",    "Cocytus",        "Oceanus",
  // Martian valley names — Kim Stanley Robinson's Mars trilogy / real Martian geography
  "Kasei",          "Nirgal",         "Ares Vale",      "Simud",          "Shalbatana",
  "Coprates",       "Hellas Run",     "Elysium",        "Candor Reach",   "Amazonis",
  "Vastitas",       "Mariner Vale",   "Valles",         "Hesperia",       "Tyrrhena",
  "Cimmeria",       "Noachis",        "Zephyria",       "Olympus Melt",
  // Outer solar system moons — Neptune, Uranus, Saturn, Pluto, Jupiter
  "Tethys Run",     "Naiad",          "Proteus",        "Triton",         "Ariel Falls",
  "Umbriel",        "Oberon",         "Miranda",        "Titania",        "Pandora",
  "Dione",          "Rhea",           "Iapetus",        "Enceladus",      "Nix",
  "Hydra",          "Europa",         "Ganymede",
  // Fiction — Philip José Farmer's Riverworld, Barsoom (Edgar Rice Burroughs)
  "Riverworld",     "River Iss",
];

// ---- Spot names ---------------------------------------------------------------

// Flat pool for scanned terrain features (beaches, canyons, etc.).
// Themes chosen not to overlap with LANDMARK_NAMES_BY_KIND or RIVER_NAMES.
export const SPOT_NAMES: readonly string[] = [
  // Star Trek planets — Federation, Klingon, Romulan, Cardassian, Bajoran space
  "Vulcan","Qo'noS","Bajor","Cardassia Prime","Ferenginar",
  "Romulus","Andoria","Betazed","Risa","Rura Penthe",
  "Ceti Alpha V","Talos IV","Argelius II","Veridian III","Exo III",
  // Doctor Who — Time Lord and alien homeworlds
  "Skaro","Gallifrey","Trenzalore","Mondas","Traken",
  "Alzarius","Peladon","Logopolis","Karn","Ribos",
  // Three-Body Problem (Cixin Liu) — Trisolaran civilisation and Dark Forest concepts
  "Trisolaris","Dark Forest","Blue Space","Bronze Age","Sophon",
  "Staircase Program","Wallfacer","Deterrence",
  // Cyberpunk / William Gibson — Neuromancer, Sprawl trilogy
  "Chiba City","Freeside","Zion Cluster","Tessier-Ashpool",
  "Wintermute","The Sprawl","Flatline","Straylight",
  // Asimov Robot & Empire worlds — Spacer worlds, Galaxia
  "Solaria","Aurora","Baleyworld","Gaia","Sayshell",
  "Melpomenia","Comporellon","Synnax",
  // Arthur C. Clarke — The City and the Stars, Rama, 2010
  "Diaspar","Lys","Rama","New Alexandria","Cradle","Tsienville",
  // Real confirmed exoplanets — named by IAU or commonly referenced in sci-fi
  "Proxima b","TRAPPIST-1e","Kepler-442b","55 Cancri e",
  "Gliese 667Cc","Tau Ceti e","Kepler-62f","HD 40307g",
  // Iain M. Banks Culture — ship names (GCUs, GSVs, ROU)
  "Sleeper Service","Mistake Not","Quietly Confident","Just Read the Instructions",
  "Experiencing A Significant Gravitas Shortfall","Lightly Seared on the Reality Grill",
  // Ursula K. Le Guin — Hainish Cycle worlds
  "Anarres","Urras","Gethen","Rocannon's World","Athshe","O","Seggri","Werel",
  // Alastair Reynolds — Revelation Space
  "Chasm City","Resurgam","Ararat","Hela","Absolution Gap",
  // The Expanse — Belt settlements and colony worlds
  "Ilus","Laconia","Medina","Ring Station",
  // Babylon 5 — homeworlds and contested systems
  "Minbar","Narn","Centauri Prime","Z'ha'dum","Rigel VII",
  // Galaxies
  "Andromeda","Triangulum","Whirlpool","Sombrero","Cartwheel",
  "Pinwheel","Sunflower","Sculptor","Centaurus A","Bode's Galaxy",
  "Large Magellanic","Small Magellanic","Black Eye","Tadpole","Antennae",
  // Nebulae
  "Orion Nebula","Crab Nebula","Eagle Nebula","Helix Nebula","Ring Nebula",
  "Horsehead","Pillars of Creation","Lagoon Nebula","Veil Nebula","Carina Nebula",
  "Rosette","Tarantula","Butterfly Nebula","Cat's Eye","Owl Nebula",
  "Flame Nebula","Pelican Nebula","Witch Head","Running Man","Soul Nebula",
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
