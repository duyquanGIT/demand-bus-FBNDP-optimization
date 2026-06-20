/**** =========================================================
 * USER PARAMETERS
 * ========================================================= ****/

var POLYGON_ASSET = "projects/charged-city-423909-e5/assets/Pulse_FDNDP_Polygon_Area";

var LINH_XUAN_ASSET = "projects/charged-city-423909-e5/assets/Pulse-FDNDP-LinhXuan";
var LINH_TRUNG_ASSET = "projects/charged-city-423909-e5/assets/Pulse-FDNDP-LinhTrung";
var THIRD_WARD_ASSET = "projects/charged-city-423909-e5/assets/Pulse-FDNDP-DongHoa";

var GRID_SIZE_M = 25;
var RADIUS_M = 500;

var HCM_DENSITY_2024 = 4554.6;     // citizens/km2
var TARGET_AREA_KM2 = 13.10875;          // VNU polygon area assumption
var MIN_DENSITY = 20;              // citizens/km2 for no-household-proxy areas

var EXPORT_NAME = "VNU_" + GRID_SIZE_M + "m_Grid_Centroids_500m_PopDensity";


/**** =========================================================
 * 1. LOAD VNU POLYGON AND PROJECTION
 * ========================================================= ****/

var studyArea = ee.FeatureCollection(POLYGON_ASSET).geometry();
var utm48n = ee.Projection("EPSG:32648");

Map.centerObject(studyArea, 15);
Map.addLayer(studyArea, { color: "red" }, "VNU Polygon");


/**** =========================================================
 * 2. LOAD HOUSEHOLD PROXY POINTS
 * ========================================================= ****/

function loadPoints(asset, wardName) {
  return ee.FeatureCollection(asset)
    .filter(ee.Filter.notNull(["Longitude", "Latitude"]))
    .filter(ee.Filter.gt("Longitude", 100))
    .filter(ee.Filter.gt("Latitude", 1))
    .map(function (f) {
      return ee.Feature(
        ee.Geometry.Point([
          ee.Number(f.get("Longitude")),
          ee.Number(f.get("Latitude"))
        ]),
        {
          source_ward: wardName,
          household_proxy: 1
        }
      );
    });
}

var householdPoints = loadPoints(LINH_XUAN_ASSET, "Linh Xuan")
  .merge(loadPoints(LINH_TRUNG_ASSET, "Linh Trung"))
  .merge(loadPoints(THIRD_WARD_ASSET, "Third Ward"))
  .filterBounds(studyArea);

print("Household proxy points inside VNU:", householdPoints.size());
Map.addLayer(householdPoints, { color: "black" }, "Household Proxy Points");


/**** =========================================================
 * 3. CREATE GRID CELLS
 * ========================================================= ****/

var bounds = studyArea.bounds().transform(utm48n, 1);
var coords = ee.List(bounds.coordinates().get(0));

var xs = coords.map(function (c) { return ee.Number(ee.List(c).get(0)); });
var ys = coords.map(function (c) { return ee.Number(ee.List(c).get(1)); });

var xmin = ee.Number(xs.reduce(ee.Reducer.min()));
var xmax = ee.Number(xs.reduce(ee.Reducer.max()));
var ymin = ee.Number(ys.reduce(ee.Reducer.min()));
var ymax = ee.Number(ys.reduce(ee.Reducer.max()));

var xSeq = ee.List.sequence(xmin, xmax.subtract(GRID_SIZE_M), GRID_SIZE_M);
var ySeq = ee.List.sequence(ymin, ymax.subtract(GRID_SIZE_M), GRID_SIZE_M);

var grid = ee.FeatureCollection(
  xSeq.map(function (x) {
    return ySeq.map(function (y) {
      x = ee.Number(x);
      y = ee.Number(y);

      var cell = ee.Geometry.Rectangle(
        [x, y, x.add(GRID_SIZE_M), y.add(GRID_SIZE_M)],
        utm48n,
        false
      );

      var clipped = cell.intersection(studyArea, 1);
      var areaKm2 = clipped.area(1).divide(1000000);

      return ee.Feature(clipped, {
        grid_size_m: GRID_SIZE_M,
        grid_area_km2: areaKm2
      });
    });
  }).flatten()
).filterBounds(studyArea);


/**** =========================================================
 * 4. CONVERT GRID CELLS TO CENTROIDS
 * ========================================================= ****/

var centroidGrid = grid.map(function (f) {
  var centroid = f.geometry().centroid(1);
  var centroidUTM = centroid.transform(utm48n, 1);

  var lonLat = centroid.coordinates();
  var xy = centroidUTM.coordinates();

  return ee.Feature(centroid, {
    grid_size_m: GRID_SIZE_M,
    grid_area_km2: f.get("grid_area_km2"),
    longitude_epsg4326: lonLat.get(0),
    latitude_epsg4326: lonLat.get(1),
    x_epsg32648: xy.get(0),
    y_epsg32648: xy.get(1)
  });
});

var gridList = centroidGrid.toList(centroidGrid.size());

var indexedGrid = ee.FeatureCollection(
  ee.List.sequence(1, centroidGrid.size()).map(function (id) {
    id = ee.Number(id);
    return ee.Feature(gridList.get(id.subtract(1))).set("grid_id", id);
  })
);


/**** =========================================================
 * 5. 500 m HOUSEHOLD PROXY INTENSITY
 * ========================================================= ****/

var pointImage = householdPoints
  .reduceToImage({
    properties: ["household_proxy"],
    reducer: ee.Reducer.sum()
  })
  .unmask(0)
  .reproject({
    crs: utm48n,
    scale: GRID_SIZE_M
  });

var localCountImage = pointImage
  .reduceNeighborhood({
    reducer: ee.Reducer.sum(),
    kernel: ee.Kernel.circle({
      radius: RADIUS_M,
      units: "meters",
      normalize: false
    }),
    skipMasked: false
  })
  .rename("local_household_proxy_count")
  .clip(studyArea);

var sampledGrid = localCountImage.sampleRegions({
  collection: indexedGrid,
  properties: [
    "grid_id",
    "grid_size_m",
    "grid_area_km2",
    "longitude_epsg4326",
    "latitude_epsg4326",
    "x_epsg32648",
    "y_epsg32648"
  ],
  scale: GRID_SIZE_M,
  projection: utm48n,
  geometries: true,
  tileScale: 4
});

var maxLocalCount = ee.Number(sampledGrid.aggregate_max("local_household_proxy_count"));

print("Maximum 500 m local household count:", maxLocalCount);


/**** =========================================================
 * 6. MASS-BALANCED POPULATION DENSITY
 * ========================================================= ****/

var withRatio = sampledGrid.map(function (f) {
  var localCount = ee.Number(f.get("local_household_proxy_count"));
  var areaKm2 = ee.Number(f.get("grid_area_km2"));

  var ratio = ee.Number(
    ee.Algorithms.If(
      maxLocalCount.gt(0),
      localCount.divide(maxLocalCount),
      0
    )
  );

  return f.set({
    density_ratio_to_vnu_max: ratio,
    ratio_area_km2: ratio.multiply(areaKm2)
  });
});

var totalGridAreaKm2 = ee.Number(withRatio.aggregate_sum("grid_area_km2"));
var totalRatioAreaKm2 = ee.Number(withRatio.aggregate_sum("ratio_area_km2"));

var targetPopulation = ee.Number(HCM_DENSITY_2024).multiply(TARGET_AREA_KM2);
var backgroundPopulation = ee.Number(MIN_DENSITY).multiply(totalGridAreaKm2);

var densityScale = ee.Number(
  ee.Algorithms.If(
    totalRatioAreaKm2.gt(0),
    targetPopulation.subtract(backgroundPopulation).divide(totalRatioAreaKm2),
    0
  )
);

var finalGrid = withRatio.map(function (f) {
  var ratio = ee.Number(f.get("density_ratio_to_vnu_max"));
  var areaKm2 = ee.Number(f.get("grid_area_km2"));

  var density = ee.Number(MIN_DENSITY).add(ratio.multiply(densityScale));
  var population = density.multiply(areaKm2);

  return f.set({
    grid_population_density: density,
    grid_population: population
  });
}).sort("grid_id");


/**** =========================================================
 * 7. VALIDATION CHECK
 * ========================================================= ****/

print("Grid size used:", GRID_SIZE_M, "m");
print("Number of grid centroids:", finalGrid.size());
print("Total clipped grid area km2:", totalGridAreaKm2);
print("Target population:", targetPopulation);
print("SUM(grid_population):", finalGrid.aggregate_sum("grid_population"));
print("Difference:", ee.Number(finalGrid.aggregate_sum("grid_population")).subtract(targetPopulation));
print("Sample output:", finalGrid.limit(10));

Map.addLayer(localCountImage, {
  min: 0,
  max: maxLocalCount,
  palette: ["white", "yellow", "orange", "red"]
}, "500 m Household Proxy Count");

Map.addLayer(finalGrid, { color: "blue" }, "Grid Centroids");


/**** =========================================================
 * 8. EXPORT TO GOOGLE DRIVE
 * ========================================================= ****/

Export.table.toDrive({
  collection: finalGrid,
  description: EXPORT_NAME,
  fileNamePrefix: EXPORT_NAME,
  fileFormat: "CSV",
  selectors: [
    "grid_id",
    "grid_size_m",
    "grid_area_km2",
    "longitude_epsg4326",
    "latitude_epsg4326",
    "x_epsg32648",
    "y_epsg32648",
    "local_household_proxy_count",
    "density_ratio_to_vnu_max",
    "grid_population_density",
    "grid_population"
  ]
});
