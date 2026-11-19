// The one list of pieces. Order here is the order of the room navigation.
// Adding a piece: a folder with index.html (see hold-space/), a module in src/pieces/, and an entry here.
//   path        URL of the piece (the build reads this to find its index.html)
//   theme       token set from src/ui/ui.css ([data-theme="…"])
//   collection  heading it is listed under in the room index
export const experiences = [
  {
    id: 'born-from-white',
    title: 'Born from white',
    path: '/',
    theme: 'space',
    collection: 'Space',
    description: 'A solar system forms out of an empty white page.',
    about: 'A solar system forms out of the white of an empty page. Hold space, or press and hold, to move through time faster.',
  },
  {
    id: 'cursor-light',
    title: 'Cursor light',
    path: '/cursor-light/',
    theme: 'space',
    collection: 'Space',
    description: 'Carry the sun with your cursor and let the planets eclipse it.',
    about: 'The sun follows your cursor or finger. Planets in front of it eclipse it, planets behind it catch its light.',
  },
  {
    id: 'hold-space',
    title: 'Hold space',
    path: '/hold-space/',
    theme: 'space',
    collection: 'Space',
    description: 'Hold to fly between the stars, let go to arrive somewhere new.',
    about: 'Floating still among the stars. Hold space, the mouse or a finger to accelerate; let go to coast to a stop somewhere new.',
  },
  {
    id: 'aurora',
    title: 'Aurora',
    path: '/aurora/',
    theme: 'space',
    collection: 'Space',
    description: 'Stir the northern lights over a frozen lake.',
    about: 'Night on a frozen world. Hold space, the mouse or a finger to strengthen the solar wind; let go and the storm settles.',
  },
];
