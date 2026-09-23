`export.copc.laz` is synthetic test data generated with PDAL 2.10.2, not survey data.
It contains a 100 × 100 grid in EPSG:31370, with point format 8 and a uint32
`TestValue` extra dimension. For index `i` from 0 to 9999:

- X = 100000 + (i % 100) × 0.2; Y = 190000 + floor(i / 100) × 0.2
- Z = 30 + (i % 7) × 0.1; intensity and red = i % 65536
- ReturnNumber = 1 + i % 3; NumberOfReturns = 3; Classification = 2 + i % 4
- GpsTime = 100000000 + i × 0.01; Green = 2345; Blue = 5432; Infrared = 8765
- PointSourceId = 42; TestValue = i

CSV input was read with `readers.text`, `override_srs: "EPSG:31370"` and written
with `writers.copc`, `extra_dims: "TestValue=uint32"`, `fixed_seed: true`.
This fixture can be redistributed under the repository's AGPL-3.0-only license.
