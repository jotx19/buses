package main

import (
	"archive/zip"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	GTFSZipURL      = "https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip"
	GTFSCacheDir    = "data"
	StopsCacheFile  = "data/stops.txt"
	GTFSMaxAgeHours = 24
	EarthRadiusM    = 6371000.0
)

type Stop struct {
	ID   string
	Code string
	Name string
	Lat  float64
	Lon  float64
}

type NearbyStop struct {
	Stop
	DistanceM float64
}

var (
	stopsMu   sync.RWMutex
	allStops  []Stop
	stopsByID map[string]Stop
	stopsErr  error
	stopsOnce sync.Once
)

func ensureStopsLoaded() error {
	stopsOnce.Do(func() {
		stopsErr = loadStops()
	})
	return stopsErr
}

func loadStops() error {
	if err := os.MkdirAll(GTFSCacheDir, 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	needRefresh := true
	if info, err := os.Stat(StopsCacheFile); err == nil {
		needRefresh = time.Since(info.ModTime()) > GTFSMaxAgeHours*time.Hour
	}

	if needRefresh {
		log.Printf("downloading OC Transpo GTFS schedule (stops only)...")
		if err := downloadStopsFromGTFS(); err != nil {
			if _, statErr := os.Stat(StopsCacheFile); statErr != nil {
				return err
			}
			log.Printf("GTFS refresh failed, using cached stops: %v", err)
		}
	}

	stops, byID, err := parseStopsFile(StopsCacheFile)
	if err != nil {
		return err
	}

	stopsMu.Lock()
	allStops = stops
	stopsByID = byID
	stopsMu.Unlock()

	log.Printf("loaded %d OC Transpo stops", len(stops))
	return nil
}

func downloadStopsFromGTFS() error {
	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Get(GTFSZipURL)
	if err != nil {
		return fmt.Errorf("download GTFS zip: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GTFS zip returned %s", resp.Status)
	}

	zipPath := filepath.Join(GTFSCacheDir, "GTFSExport.zip")
	out, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		return err
	}
	out.Close()
	defer os.Remove(zipPath)

	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open GTFS zip: %w", err)
	}
	defer zr.Close()

	var stopsEntry *zip.File
	for _, f := range zr.File {
		if filepath.Base(f.Name) == "stops.txt" {
			stopsEntry = f
			break
		}
	}
	if stopsEntry == nil {
		return fmt.Errorf("stops.txt not found in GTFS zip")
	}

	rc, err := stopsEntry.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	tmp := StopsCacheFile + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, rc); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, StopsCacheFile)
}

func parseStopsFile(path string) ([]Stop, map[string]Stop, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	header, err := r.Read()
	if err != nil {
		return nil, nil, err
	}
	idx := map[string]int{}
	for i, h := range header {
		idx[h] = i
	}
	for _, col := range []string{"stop_id", "stop_name", "stop_lat", "stop_lon"} {
		if _, ok := idx[col]; !ok {
			return nil, nil, fmt.Errorf("stops.txt missing column %s", col)
		}
	}

	stops := make([]Stop, 0, 6000)
	byID := make(map[string]Stop, 6000)
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		lat, err1 := strconv.ParseFloat(row[idx["stop_lat"]], 64)
		lon, err2 := strconv.ParseFloat(row[idx["stop_lon"]], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		s := Stop{
			ID:   row[idx["stop_id"]],
			Name: row[idx["stop_name"]],
			Lat:  lat,
			Lon:  lon,
		}
		if i, ok := idx["stop_code"]; ok && i < len(row) {
			s.Code = row[i]
		}
		stops = append(stops, s)
		byID[s.ID] = s
	}
	return stops, byID, nil
}

func nearbyStops(lat, lon, radiusM float64) []NearbyStop {
	stopsMu.RLock()
	defer stopsMu.RUnlock()

	out := make([]NearbyStop, 0, 32)
	for _, s := range allStops {
		d := haversineMeters(lat, lon, s.Lat, s.Lon)
		if d <= radiusM {
			out = append(out, NearbyStop{Stop: s, DistanceM: d})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].DistanceM < out[j].DistanceM
	})
	return out
}

func getStop(id string) (Stop, bool) {
	stopsMu.RLock()
	defer stopsMu.RUnlock()
	s, ok := stopsByID[id]
	return s, ok
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	toRad := math.Pi / 180
	dLat := (lat2 - lat1) * toRad
	dLon := (lon2 - lon1) * toRad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*toRad)*math.Cos(lat2*toRad)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * EarthRadiusM * math.Asin(math.Sqrt(a))
}
