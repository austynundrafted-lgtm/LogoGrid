/////////////////////////////////////////////////////////////////
//
// Adobe Illustrator : Logo Grid Lines
// v1.3
//
// This script generates a series of Grid Lines of selected artwork on a separate layer.
//
// UPDATES
//
// v1.3 [ 2025-09-22 ]
// - Added arc consolidation to prevent overlapping circles from multi-segment curves
// - Improved parallel line detection with 5px position and 2° angle tolerance
// - Enhanced circle validation and filtering
// - Circle consolidation tolerance set to 3% for more precise detection
// - Added phantom circle validation to prevent false positive large circles
// - Enhanced geometric relevance checking for detected circles
// - Added artwork bounds validation to filter unrealistic circles
// - Improved detection of small construction circles (min 8px radius, down from 20px)
// - Lowered minimum arc length threshold to 15px for tighter curves
// - Enhanced validation with size-based tolerances for small vs large circles
// - Refined consolidation logic (3% tolerance) to preserve distinct circles
// - Better sampling accuracy with 4 curve points instead of 3
//
// v1.2 [ 2025-07-01 ]
// - Added arc detection to find curved segments that could be part of full circles.
// - Creates complete circle guidelines on a new "Arcs" layer.
// - Detects circles from curved path segments using three-point circle calculation.
// - Guidelines now use RGB (0,0,0) for all strokes.
//
// v1.1 [ 2024-11-14 ]
// - Added a new function to add squares on every anchor point of the selected artwork.
// - Squares are 15px by 15px, White Fill, 1px Black Stroke.
// - Squares generate on a new layer called Points.
//
// v1.0 [ 2024-11-09 ]
// - Creates horizontal, vertical, and angular Grid Lines based on the selected artwork.
// - Grid Lines are generated as Solid, Black, 1px lines, on a separate layer named Guidelines.
// - Grid lines do not extend beyond the edges of the artboard.
//
/////////////////////////////////////////////////////////////////
//
// JS Code originally developed by Studio Gibbous www.studiogibbous.com
// Released under Creative Commons (CC) License
//
/////////////////////////////////////////////////////////////////

// =================================================================
// SECTION 1: UTILITY FUNCTIONS
// =================================================================

// Function to create a new layer and return it
function createNewLayer(layerName) {
  var doc = app.activeDocument;
  var newLayer = doc.layers.add();
  newLayer.name = layerName;
  return newLayer;
}

// Function to check if two points are equal
function arePointsEqual(p1, p2, tolerance) {
  tolerance = tolerance || 0.001; // Set default tolerance if not provided
  return (
    Math.abs(p1[0] - p2[0]) < tolerance && Math.abs(p1[1] - p2[1]) < tolerance
  );
}

// Function to calculate distance between two points
function getDistance(p1, p2) {
  return Math.sqrt(Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2));
}

// =================================================================
// SECTION 2: LINE DETECTION AND COMPARISON FUNCTIONS
// =================================================================

// Function to check if two lines are parallel within a tolerance
function areLinesParallel(line1, line2, angleTolerance) {
  angleTolerance = angleTolerance || 2; // Default 2 degrees tolerance

  // Calculate angles of both lines
  var angle1 =
    (Math.atan2(line1[1][1] - line1[0][1], line1[1][0] - line1[0][0]) * 180) /
    Math.PI;
  var angle2 =
    (Math.atan2(line2[1][1] - line2[0][1], line2[1][0] - line2[0][0]) * 180) /
    Math.PI;

  // Normalize angles to 0-180 range (since lines can go both directions)
  angle1 = Math.abs(angle1) % 180;
  angle2 = Math.abs(angle2) % 180;

  // Check if angles are within tolerance
  var angleDiff = Math.abs(angle1 - angle2);
  return angleDiff <= angleTolerance || angleDiff >= 180 - angleTolerance;
}

// Function to check if two lines are identical or very similar
function areLinesEqual(line1, line2) {
  var positionTolerance = 1; // 1 pixel tolerance for position
  var angleTolerance = 2; // 2 degree tolerance for angle

  // Check exact match first
  if (
    (arePointsEqual(line1[0], line2[0], positionTolerance) &&
      arePointsEqual(line1[1], line2[1], positionTolerance)) ||
    (arePointsEqual(line1[0], line2[1], positionTolerance) &&
      arePointsEqual(line1[1], line2[0], positionTolerance))
  ) {
    return true;
  }

  // Check if lines are parallel and very close
  if (areLinesParallel(line1, line2, angleTolerance)) {
    // Calculate distance between parallel lines
    // Use point-to-line distance formula
    var x0 = line1[0][0],
      y0 = line1[0][1];
    var x1 = line2[0][0],
      y1 = line2[0][1];
    var x2 = line2[1][0],
      y2 = line2[1][1];

    var distance =
      Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) /
      Math.sqrt(Math.pow(y2 - y1, 2) + Math.pow(x2 - x1, 2));

    return distance < positionTolerance * 5; // Allow 5 pixel tolerance for parallel lines
  }

  return false;
}

// =================================================================
// SECTION 3: CIRCLE DETECTION AND COMPARISON FUNCTIONS
// =================================================================

// Function to check if two circles are identical
function areCirclesEqual(circle1, circle2, tolerance) {
  tolerance = tolerance || 0.001;
  return (
    arePointsEqual(circle1.center, circle2.center, tolerance) &&
    Math.abs(circle1.radius - circle2.radius) < tolerance
  );
}

// Function to check if two circles are overlapping/close enough to be consolidated
function areCirclesOverlapping(circle1, circle2, tolerance) {
  tolerance = tolerance || 0.05; // 5% tolerance - optimal balance

  var centerDistance = getDistance(circle1.center, circle2.center);
  var radiusDiff = Math.abs(circle1.radius - circle2.radius);
  var avgRadius = (circle1.radius + circle2.radius) / 2;

  // Only consolidate circles from the same source item (if specified)
  if (
    circle1.sourceItem &&
    circle2.sourceItem &&
    circle1.sourceItem !== circle2.sourceItem
  ) {
    // Be much more restrictive when consolidating across different path items
    tolerance = tolerance * 0.3; // Reduce tolerance to 1.5% for cross-item consolidation
  }

  // More restrictive consolidation - only merge circles that are very similar
  // Check if circles are concentric or nearly concentric
  var isConcentricish = centerDistance < avgRadius * tolerance;

  // Check if circles are very similar in size
  var isSimilarSize = radiusDiff < avgRadius * tolerance;

  // More restrictive containment check - only merge if one is clearly inside the other
  var isContained =
    centerDistance + Math.min(circle1.radius, circle2.radius) <
    Math.max(circle1.radius, circle2.radius) * (1 + tolerance);

  // Only consolidate if circles are both concentric AND similar size, or clearly contained
  return (isConcentricish && isSimilarSize) || isContained;
}

// Function to find the best representative circle from a group of overlapping circles
function findBestCircleFromGroup(circleGroup) {
  if (circleGroup.length === 1) {
    return circleGroup[0];
  }

  // Find the circle with the median radius (most representative)
  var sortedByRadius = circleGroup.slice().sort(function (a, b) {
    return a.radius - b.radius;
  });

  var medianIndex = Math.floor(sortedByRadius.length / 2);
  return sortedByRadius[medianIndex];
}

// Enhanced function to consolidate overlapping circles while preserving cross-item circles
function consolidateOverlappingCircles(circles) {
  var consolidatedCircles = [];
  var processed = [];

  for (var i = 0; i < circles.length; i++) {
    if (processed[i]) continue;

    var currentGroup = [circles[i]];
    processed[i] = true;

    // Find all circles that overlap with the current one
    for (var j = i + 1; j < circles.length; j++) {
      if (processed[j]) continue;

      if (areCirclesOverlapping(circles[i], circles[j])) {
        currentGroup.push(circles[j]);
        processed[j] = true;
      }
    }

    // Find the best representative circle from this group
    var bestCircle = findBestCircleFromGroup(currentGroup);
    consolidatedCircles.push(bestCircle);
  }

  return consolidatedCircles;
}

// Function to calculate circle from three points using circumcircle formula
function calculateCircleFromThreePoints(p1, p2, p3) {
  var x1 = p1[0],
    y1 = p1[1];
  var x2 = p2[0],
    y2 = p2[1];
  var x3 = p3[0],
    y3 = p3[1];

  // Calculate the determinant
  var d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));

  // Check if points are collinear (determinant is zero)
  if (Math.abs(d) < 0.001) {
    return null; // Points are collinear, can't form a circle
  }

  // Calculate center coordinates
  var ux =
    ((x1 * x1 + y1 * y1) * (y2 - y3) +
      (x2 * x2 + y2 * y2) * (y3 - y1) +
      (x3 * x3 + y3 * y3) * (y1 - y2)) /
    d;
  var uy =
    ((x1 * x1 + y1 * y1) * (x3 - x2) +
      (x2 * x2 + y2 * y2) * (x1 - x3) +
      (x3 * x3 + y3 * y3) * (x2 - x1)) /
    d;

  // Calculate radius
  var radius = getDistance([ux, uy], p1);

  return {
    center: [ux, uy],
    radius: radius,
  };
}

// =================================================================
// SECTION 4: PHANTOM CIRCLE VALIDATION FUNCTIONS
// =================================================================

// Function to validate if a circle is geometrically relevant to the curved segment
function isCircleGeometricallyRelevant(circle, curvePoints, chordLength) {
  // Rule 1: Circle radius should be proportional to chord length
  // More lenient for smaller circles - allow wider range for small construction circles
  var minReasonableRadius = Math.min(chordLength * 0.2, 8); // Allow very small circles (min 8px)
  var maxReasonableRadius = chordLength * 12; // Slightly more lenient for larger circles

  if (
    circle.radius < minReasonableRadius ||
    circle.radius > maxReasonableRadius
  ) {
    return false;
  }

  // Rule 2: Circle center should be reasonably close to the curve
  // More lenient for smaller circles which tend to have centers further away
  var midPoint = curvePoints[Math.floor(curvePoints.length / 2)];
  var centerToMidDistance = getDistance(circle.center, midPoint);

  // Dynamic tolerance based on circle size - smaller circles get more leeway
  var centerDistanceTolerance = circle.radius < 50 ? 5 : 3;
  if (centerToMidDistance > circle.radius * centerDistanceTolerance) {
    return false;
  }

  // Rule 3: Validate arc angle - should represent a reasonable portion of circle
  var p1 = curvePoints[0];
  var p3 = curvePoints[curvePoints.length - 1];
  var angle1 = Math.atan2(p1[1] - circle.center[1], p1[0] - circle.center[0]);
  var angle3 = Math.atan2(p3[1] - circle.center[1], p3[0] - circle.center[0]);
  var arcAngle = Math.abs(angle3 - angle1);
  if (arcAngle > Math.PI) arcAngle = 2 * Math.PI - arcAngle; // Take smaller angle

  // More lenient arc angle requirements - especially for small circles
  var minAngle =
    circle.radius < 30 ? (8 * Math.PI) / 180 : (12 * Math.PI) / 180; // 8-12 degrees
  var maxAngle = (300 * Math.PI) / 180; // 300 degrees (more lenient)

  if (arcAngle < minAngle || arcAngle > maxAngle) {
    return false;
  }

  return true;
}

// Function to check if circle is reasonable relative to individual item's artwork bounds
function isCircleWithinReasonableBounds(circle, artworkBounds, chordLength) {
  // Calculate artwork dimensions for THIS SPECIFIC ITEM ONLY
  var artworkWidth = artworkBounds.right - artworkBounds.left;
  var artworkHeight = artworkBounds.top - artworkBounds.bottom;
  var artworkMaxDimension = Math.max(artworkWidth, artworkHeight);

  // More lenient size limits - allow circles up to 2.5x this item's artwork size
  if (circle.radius > artworkMaxDimension * 2.5) {
    return false;
  }

  // More lenient center distance - especially for smaller circles
  var artworkCenterX = (artworkBounds.left + artworkBounds.right) / 2;
  var artworkCenterY = (artworkBounds.top + artworkBounds.bottom) / 2;
  var distanceToArtworkCenter = getDistance(circle.center, [
    artworkCenterX,
    artworkCenterY,
  ]);

  // Dynamic tolerance - smaller circles can be further from center
  var centerDistanceLimit =
    circle.radius < 50
      ? artworkMaxDimension * 3 // Small circles get 3x leeway
      : artworkMaxDimension * 2.5; // Larger circles get 2.5x leeway

  if (distanceToArtworkCenter > centerDistanceLimit) {
    return false;
  }

  return true;
}

// Function to get artwork bounds from all path points of a single item
function getArtworkBounds(item) {
  var bounds = {
    left: Infinity,
    right: -Infinity,
    top: -Infinity,
    bottom: Infinity,
  };

  var points = item.pathPoints;
  if (points) {
    for (var i = 0; i < points.length; i++) {
      var x = points[i].anchor[0];
      var y = points[i].anchor[1];

      if (x < bounds.left) bounds.left = x;
      if (x > bounds.right) bounds.right = x;
      if (y > bounds.top) bounds.top = y;
      if (y < bounds.bottom) bounds.bottom = y;
    }
  }

  return bounds;
}

// =================================================================
// SECTION 5: CREATION FUNCTIONS (VISUAL OUTPUT)
// =================================================================

// Function to create circle guidelines with consolidation
function createConsolidatedCircleGuidelines(detectedCircles, layer) {
  if (detectedCircles.length === 0) return;

  // Consolidate overlapping circles first
  var consolidatedCircles = consolidateOverlappingCircles(detectedCircles);
  var existingCircles = [];

  // Create guidelines for the consolidated circles
  for (var i = 0; i < consolidatedCircles.length; i++) {
    var circle = consolidatedCircles[i];
    createCircleGuideline(
      circle.center[0],
      circle.center[1],
      circle.radius,
      layer,
      existingCircles,
    );
  }
}

// New function to create circle guidelines from independently processed circles
function createCircleGuidelinesFromIndependentItems(circles, layer) {
  if (circles.length === 0) return;

  var existingCircles = [];

  // Create guidelines for all circles (no further consolidation needed)
  for (var i = 0; i < circles.length; i++) {
    var circle = circles[i];
    createCircleGuideline(
      circle.center[0],
      circle.center[1],
      circle.radius,
      layer,
      existingCircles,
    );
  }
}

// Function to create a guideline as one continuous line with no fill
function createGuideline(startX, startY, endX, endY, layer, existingLines) {
  var newLine = [
    [startX, startY],
    [endX, endY],
  ];

  // Check if this line already exists in existingLines
  for (var i = 0; i < existingLines.length; i++) {
    if (areLinesEqual(newLine, existingLines[i])) {
      return; // Skip creating the line if a duplicate is found
    }
  }

  // Add the new line to the existingLines array to keep track
  existingLines.push(newLine);

  // Create the actual guideline on the layer
  var doc = app.activeDocument;
  var line = layer.pathItems.add();
  line.setEntirePath(newLine);
  line.stroked = true;
  line.strokeWidth = 1; // Set line thickness to 1 pixel
  // Create RGB black color
  var blackColor = new RGBColor();
  blackColor.red = 0;
  blackColor.green = 0;
  blackColor.blue = 0;
  line.strokeColor = blackColor; // Solid black color
  line.filled = false; // Ensure there is no fill
}

// Function to create a circle guideline
function createCircleGuideline(
  centerX,
  centerY,
  radius,
  layer,
  existingCircles,
) {
  var newCircle = {
    center: [centerX, centerY],
    radius: radius,
  };

  // Check if this circle already exists
  for (var i = 0; i < existingCircles.length; i++) {
    if (areCirclesEqual(newCircle, existingCircles[i])) {
      return; // Skip creating the circle if a duplicate is found
    }
  }

  // Add the new circle to the existingCircles array
  existingCircles.push(newCircle);

  // Create the actual circle guideline on the layer
  var doc = app.activeDocument;
  var circle = layer.pathItems.ellipse(
    centerY + radius, // top
    centerX - radius, // left
    radius * 2, // width
    radius * 2, // height
  );
  circle.stroked = true;
  circle.strokeWidth = 1;
  // Create RGB black color
  var blackColor = new RGBColor();
  blackColor.red = 0;
  blackColor.green = 0;
  blackColor.blue = 0;
  circle.strokeColor = blackColor; // Solid black color
  circle.filled = false; // Ensure there is no fill
}

// =================================================================
// SECTION 6: CURVED SEGMENT ANALYSIS
// =================================================================

// Function to check if a path segment is curved (has control points)
function isSegmentCurved(pathPoint, nextPathPoint) {
  // Check if either point has control handles that are not coincident with the anchor
  var hasRightHandle = !arePointsEqual(
    pathPoint.anchor,
    pathPoint.rightDirection,
  );
  var hasLeftHandle = !arePointsEqual(
    nextPathPoint.anchor,
    nextPathPoint.leftDirection,
  );

  return hasRightHandle || hasLeftHandle;
}

// Function to get points along a curved segment for circle calculation
function getPointsOnCurvedSegment(pathPoint, nextPathPoint, numSamples) {
  numSamples = numSamples || 5; // Default to 5 sample points
  var points = [];

  var p0 = pathPoint.anchor;
  var p1 = pathPoint.rightDirection;
  var p2 = nextPathPoint.leftDirection;
  var p3 = nextPathPoint.anchor;

  // Sample points along the bezier curve
  for (var i = 0; i <= numSamples; i++) {
    var t = i / numSamples;

    // Cubic bezier curve calculation
    var x =
      Math.pow(1 - t, 3) * p0[0] +
      3 * Math.pow(1 - t, 2) * t * p1[0] +
      3 * (1 - t) * Math.pow(t, 2) * p2[0] +
      Math.pow(t, 3) * p3[0];

    var y =
      Math.pow(1 - t, 3) * p0[1] +
      3 * Math.pow(1 - t, 2) * t * p1[1] +
      3 * (1 - t) * Math.pow(t, 2) * p2[1] +
      Math.pow(t, 3) * p3[1];

    points.push([x, y]);
  }

  return points;
}

// Modified function to collect circles with independent item bounds validation
function detectCirclesFromCurvedSegments(item, detectedCircles, sourceItemId) {
  var points = item.pathPoints;
  var minRadius = 8; // Lowered from 20px to catch small construction circles
  var maxRadius = 1500; // Maximum radius for circle detection
  var minArcLength = 15; // Lowered from 30px to catch tighter curves

  // Get artwork bounds for THIS SPECIFIC ITEM ONLY - not combined with other selected items
  var artworkBounds = getArtworkBounds(item);

  if (points && points.length > 1) {
    for (var j = 0; j < points.length; j++) {
      var currentPoint = points[j];
      var nextPoint = points[(j + 1) % points.length];

      // Check if this segment is curved and significant
      if (isSegmentCurved(currentPoint, nextPoint)) {
        // Calculate approximate arc length
        var startX = currentPoint.anchor[0];
        var startY = currentPoint.anchor[1];
        var endX = nextPoint.anchor[0];
        var endY = nextPoint.anchor[1];
        var chordLength = Math.sqrt(
          Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2),
        );

        // Only process curves with significant chord length
        if (chordLength >= minArcLength) {
          // Get sample points along the curve - more samples for better accuracy
          var curvePoints = getPointsOnCurvedSegment(
            currentPoint,
            nextPoint,
            4,
          );

          // Try to find circles using three points
          if (curvePoints.length >= 3) {
            var p1 = curvePoints[0];
            var p2 = curvePoints[Math.floor(curvePoints.length / 2)];
            var p3 = curvePoints[curvePoints.length - 1];

            var circle = calculateCircleFromThreePoints(p1, p2, p3);

            if (
              circle &&
              circle.radius >= minRadius &&
              circle.radius <= maxRadius
            ) {
              // Phantom circle validation using ONLY this item's bounds
              if (
                !isCircleGeometricallyRelevant(circle, curvePoints, chordLength)
              ) {
                continue; // Skip this phantom circle
              }

              if (
                !isCircleWithinReasonableBounds(
                  circle,
                  artworkBounds,
                  chordLength,
                )
              ) {
                continue; // Skip this phantom circle
              }

              // More lenient validation for smaller circles
              var validCircle = true;
              var tolerance =
                circle.radius < 25
                  ? Math.max(circle.radius * 0.05, 3) // 5% tolerance for small circles, min 3px
                  : Math.max(circle.radius * 0.02, 2); // 2% tolerance for larger circles, min 2px

              for (var m = 0; m < curvePoints.length; m++) {
                var distanceFromCenter = getDistance(
                  circle.center,
                  curvePoints[m],
                );
                if (Math.abs(distanceFromCenter - circle.radius) > tolerance) {
                  validCircle = false;
                  break;
                }
              }

              if (validCircle) {
                // Add source item tracking for better consolidation
                circle.sourceItem = sourceItemId;
                detectedCircles.push(circle);
              }
            }
          }
        }
      }
    }
  }
}

// =================================================================
// SECTION 7: ARTBOARD AND LINE EXTENSION FUNCTIONS
// =================================================================

// Function to calculate the exact intersections of a line with the artboard edges
function getArtboardIntersections(startX, startY, dx, dy) {
  var doc = app.activeDocument;
  var artboard = doc.artboards[doc.artboards.getActiveArtboardIndex()];
  var artboardRect = artboard.artboardRect; // [left, top, right, bottom]

  var x1 = artboardRect[0]; // Left
  var y1 = artboardRect[1]; // Top
  var x2 = artboardRect[2]; // Right
  var y2 = artboardRect[3]; // Bottom

  var intersections = [];

  if (dx !== 0) {
    var t1 = (x1 - startX) / dx;
    var t2 = (x2 - startX) / dx;
    var yAtX1 = startY + t1 * dy;
    var yAtX2 = startY + t2 * dy;
    if (yAtX1 >= y2 && yAtX1 <= y1) intersections.push([x1, yAtX1]);
    if (yAtX2 >= y2 && yAtX2 <= y1) intersections.push([x2, yAtX2]);
  }
  if (dy !== 0) {
    var t3 = (y1 - startY) / dy;
    var t4 = (y2 - startY) / dy;
    var xAtY1 = startX + t3 * dx;
    var xAtY2 = startX + t4 * dx;
    if (xAtY1 >= x1 && xAtY1 <= x2) intersections.push([xAtY1, y1]);
    if (xAtY2 >= x1 && xAtY2 <= x2) intersections.push([xAtY2, y2]);
  }

  return intersections;
}

// Function to extend a line across the artboard while preserving the exact angle
function extendAcrossArtboard(
  startX,
  startY,
  endX,
  endY,
  layer,
  existingLines,
) {
  // Calculate direction vector
  var dx = endX - startX;
  var dy = endY - startY;

  // Get intersections in both directions
  var intersections = getArtboardIntersections(startX, startY, dx, dy);

  if (intersections.length >= 2) {
    // Sort intersections by distance to determine the farthest points
    intersections.sort(function (a, b) {
      var distA = Math.sqrt(
        Math.pow(a[0] - startX, 2) + Math.pow(a[1] - startY, 2),
      );
      var distB = Math.sqrt(
        Math.pow(b[0] - startX, 2) + Math.pow(b[1] - startY, 2),
      );
      return distA - distB;
    });

    // Use the farthest two points to create one continuous line
    var farthestPoint1 = intersections[0];
    var farthestPoint2 = intersections[intersections.length - 1];
    createGuideline(
      farthestPoint1[0],
      farthestPoint1[1],
      farthestPoint2[0],
      farthestPoint2[1],
      layer,
      existingLines,
    );
  }
}

// =================================================================
// SECTION 8: PATH PROCESSING FUNCTIONS
// =================================================================

// Function to process a single path item for grid lines
function processPathItem(item, layer, existingLines) {
  var points = item.pathPoints;
  var minSegmentLength = 10; // Minimum segment length to create a guideline (in pixels)

  if (points) {
    for (var j = 0; j < points.length; j++) {
      var point = points[j];
      var startX = point.anchor[0];
      var startY = point.anchor[1];
      var nextPoint = points[(j + 1) % points.length];
      var endX = nextPoint.anchor[0];
      var endY = nextPoint.anchor[1];

      // Calculate segment length
      var segmentLength = Math.sqrt(
        Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2),
      );

      // Only create guidelines for segments longer than minimum length
      // and skip curved segments (they'll be handled by arc detection)
      if (
        segmentLength >= minSegmentLength &&
        !isSegmentCurved(point, nextPoint)
      ) {
        // Extend the guideline preserving the exact direction of the artwork
        extendAcrossArtboard(startX, startY, endX, endY, layer, existingLines);
      }
    }
  }
}

// Recursive function to process all items in a group or compound path for grid lines
function processGroupItem(item, layer, existingLines) {
  if (item.typename === "GroupItem") {
    for (var i = 0; i < item.pageItems.length; i++) {
      processGroupItem(item.pageItems[i], layer, existingLines);
    }
  } else if (item.typename === "CompoundPathItem") {
    for (var j = 0; j < item.pathItems.length; j++) {
      processPathItem(item.pathItems[j], layer, existingLines);
    }
  } else if (item.typename === "PathItem") {
    processPathItem(item, layer, existingLines);
  }
}

// Enhanced recursive function to process items for arc detection with source tracking
function processGroupItemForArcs(item, detectedCircles, sourceItemId) {
  if (item.typename === "GroupItem") {
    for (var i = 0; i < item.pageItems.length; i++) {
      processGroupItemForArcs(
        item.pageItems[i],
        detectedCircles,
        sourceItemId + "_group_" + i,
      );
    }
  } else if (item.typename === "CompoundPathItem") {
    for (var j = 0; j < item.pathItems.length; j++) {
      detectCirclesFromCurvedSegments(
        item.pathItems[j],
        detectedCircles,
        sourceItemId + "_compound_" + j,
      );
    }
  } else if (item.typename === "PathItem") {
    detectCirclesFromCurvedSegments(item, detectedCircles, sourceItemId);
  }
}

// =================================================================
// SECTION 9: ANCHOR POINT SQUARES FUNCTION
// =================================================================

// Function to add squares at anchor points
function addSquaresAtAnchorPoints(layer) {
  var doc = app.activeDocument;
  var selection = doc.selection;
  var uniquePoints = {}; // To store unique points

  // Function to process each item, including groups
  function processItem(item) {
    if (item.typename === "PathItem") {
      var pathPoints = item.pathPoints;

      // Loop through each anchor point
      for (var j = 0; j < pathPoints.length; j++) {
        var anchorPoint = pathPoints[j].anchor;
        var pointKey =
          anchorPoint[0].toFixed(2) + "," + anchorPoint[1].toFixed(2); // Use anchor point as unique key

        // If the point is not already processed, add a square
        if (!uniquePoints[pointKey]) {
          uniquePoints[pointKey] = true;

          // Create a 15x15 square at the anchor point
          var square = layer.pathItems.rectangle(
            anchorPoint[1] + 7.5,
            anchorPoint[0] - 7.5,
            15,
            15,
          );
          square.fillColor = new RGBColor();
          square.fillColor.red = 255;
          square.fillColor.green = 255;
          square.fillColor.blue = 255; // White color for the fill
          // Create RGB black color for stroke
          var blackColor = new RGBColor();
          blackColor.red = 0;
          blackColor.green = 0;
          blackColor.blue = 0;
          square.strokeColor = blackColor; // Black stroke
          square.strokeWidth = 1; // 1px stroke
        }
      }
    } else if (item.typename === "GroupItem") {
      // If it's a group, recursively process each item within the group
      for (var i = 0; i < item.pageItems.length; i++) {
        processItem(item.pageItems[i]);
      }
    }
  }

  // Loop through all selected items
  for (var i = 0; i < selection.length; i++) {
    processItem(selection[i]);
  }
}

// =================================================================
// SECTION 10: MAIN EXECUTION FUNCTIONS
// =================================================================

// Enhanced function to process each selected item completely independently
function processSelectedItems() {
  var doc = app.activeDocument;
  var selection = doc.selection;

  if (selection.length === 0) {
    alert("Please select artwork.");
    return;
  }

  var guidelinesLayer = createNewLayer("Guidelines");
  var pointsLayer = createNewLayer("Points");
  var arcsLayer = createNewLayer("Arcs");
  var existingLines = []; // Keep track of created lines to avoid duplicates
  var allFinalCircles = []; // Collect all independently processed circles

  // Process each selected item completely independently
  for (var i = 0; i < selection.length; i++) {
    // Process grid lines (this can remain combined since lines don't interfere)
    processGroupItem(selection[i], guidelinesLayer, existingLines);

    // Process circles for THIS ITEM ONLY - completely independent
    var itemCircles = []; // Circles for this specific item only
    var sourceItemId = "item_" + i;
    processGroupItemForArcs(selection[i], itemCircles, sourceItemId);

    // Consolidate circles WITHIN this item only
    var consolidatedItemCircles = consolidateOverlappingCircles(itemCircles);

    // Add this item's circles to the master collection
    for (var j = 0; j < consolidatedItemCircles.length; j++) {
      allFinalCircles.push(consolidatedItemCircles[j]);
    }
  }

  // Create circle guidelines from all independently processed circles
  // No further consolidation across items - they've been processed separately
  createCircleGuidelinesFromIndependentItems(allFinalCircles, arcsLayer);

  // Add squares to anchor points on the "Points" layer
  addSquaresAtAnchorPoints(pointsLayer);
}

// Run the main function to generate guidelines, arcs, and squares
function runScript() {
  processSelectedItems();
}

runScript();
