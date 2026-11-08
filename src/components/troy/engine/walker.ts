// A point in the world, in world units (z is height above the ground). Figures walk and ride
// through lists of these: see CampScene.run and CampScene.ride in scenes/camp.ts.

export type Point = { x: number; y: number; z: number };
