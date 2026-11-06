package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"
)

// demoBridge simulates media sessions, meters and devices (non-Windows / --demo).
type demoBridge struct {
	mu        sync.Mutex
	playing   bool
	pos       float64
	track     int
	def       string
	stop      chan struct{}
	devicesFn func()
}

type demoTrack struct {
	title, artist, album string
	dur                  float64
	hue                  int
}

var demoTracks = []demoTrack{
	{"Goldberg Variations, BWV 988: Aria", "示範鋼琴獨奏", "Bach: Goldberg Variations", 287, 24},
	{"Cello Suite No. 1: Prélude", "示範大提琴", "Six Suites (Demo)", 151, 200},
	{"Clair de lune", "示範鋼琴獨奏", "Suite bergamasque", 302, 330},
}

func demoArt(t demoTrack) []byte {
	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
<rect width="600" height="600" fill="hsl(%d,32%%,24%%)"/>
<circle cx="390" cy="250" r="190" fill="hsl(%d,45%%,48%%)"/>
<rect x="-40" y="380" width="700" height="70" fill="#e9dfcf" transform="rotate(-18 300 415)"/>
<rect x="60" y="70" width="40" height="300" fill="#151210"/>
<text x="60" y="540" font-family="sans-serif" font-size="46" font-weight="700" fill="#e9dfcf">%s</text>
</svg>`, t.hue, (t.hue+30)%360, "DEMO")
	return []byte(svg)
}

func startDemoBridge(a *app) bridge {
	d := &demoBridge{playing: true, pos: 74, def: "{demo-multich}", stop: make(chan struct{})}
	emit := func(v any) {
		b, _ := json.Marshal(v)
		a.onBridgeLine(b)
	}
	emit(map[string]any{"t": "init", "eapoConfig": a.configDir(), "winrt": true, "audio": true})
	sendArt := func(i int) string {
		key := fmt.Sprintf("demo%d", i)
		emit(map[string]any{"t": "art", "key": key, "mime": "image/svg+xml", "b64": base64.StdEncoding.EncodeToString(demoArt(demoTracks[i]))})
		return key
	}
	for i := range demoTracks {
		sendArt(i)
	}
	devices := func() {
		d.mu.Lock()
		def := d.def
		d.mu.Unlock()
		emit(map[string]any{"t": "devices", "def": def, "list": []map[string]any{
			{"guid": "{demo-multich}", "name": "喇叭", "iface": "USB 7.1 Sound Card", "eapo": true},
			{"guid": "{demo-dac}", "name": "喇叭", "iface": "USB Stereo DAC", "eapo": true},
			{"guid": "{demo-onboard}", "name": "喇叭", "iface": "Onboard HD Audio", "eapo": false},
			{"guid": "{demo-hdmi}", "name": "Monitor", "iface": "HDMI Audio", "eapo": false},
			{"guid": "{demo-bt}", "name": "耳機", "iface": "Wireless Over-Ear Headphones Pro", "eapo": true},
		}})
	}
	devices()
	emit(map[string]any{"t": "bt", "list": []map[string]any{
		{"name": "Wireless Over-Ear Headphones Pro", "id": "BTHENUM\\DEV_1", "battery": 80, "connected": true, "hfp": []map[string]string{{"id": "BTHHFENUM\\1", "status": "OK", "name": "Wireless Over-Ear Headphones Pro Hands-Free"}}},
		{"name": "Wireless Over-Ear Headphones Pro", "id": "BTHLE\\DEV_1", "battery": nil, "connected": true, "hfp": []map[string]string{{"id": "BTHHFENUM\\1", "status": "OK", "name": "Wireless Over-Ear Headphones Pro Hands-Free"}}},
		{"name": "True Wireless Buds 6 Pro", "id": "BTHENUM\\DEV_2", "battery": nil, "connected": false, "last": "2026-11-02T07:13:10", "hfp": []map[string]string{{"id": "BTHHFENUM\\2", "status": "Unknown", "name": "True Wireless Buds 6 Pro Hands-Free"}}},
		{"name": "Travel Earbuds 2 Ultra", "id": "BTHENUM\\DEV_3", "battery": nil, "connected": false, "hfp": []map[string]string{{"id": "BTHHFENUM\\3", "status": "Unknown", "name": "Travel Earbuds 2 Ultra Hands-Free"}}},
		{"name": "Sport Buds SI", "id": "BTHLE\\DEV_4", "battery": 100, "connected": false, "hfp": []map[string]string{{"id": "BTHHFENUM\\4", "status": "Unknown", "name": "Sport Buds SI Hands-Free"}}},
	}})
	go func() {
		tick := time.NewTicker(80 * time.Millisecond)
		defer tick.Stop()
		n := 0
		for {
			select {
			case <-d.stop:
				return
			case <-tick.C:
			}
			n++
			d.mu.Lock()
			if d.playing {
				d.pos += 0.08
				if d.pos >= demoTracks[d.track].dur {
					d.pos = 0
					d.track = (d.track + 1) % len(demoTracks)
				}
			}
			t := demoTracks[d.track]
			playing, pos, tr := d.playing, d.pos, d.track
			d.mu.Unlock()
			if n%6 == 0 {
				st := "Paused"
				if playing {
					st = "Playing"
				}
				emit(map[string]any{"t": "media", "cur": "Spotify.exe", "sessions": []map[string]any{
					{"id": "Spotify.exe", "title": t.title, "artist": t.artist, "album": t.album, "status": st, "pos": math.Round(pos*100) / 100, "dur": t.dur, "art": fmt.Sprintf("demo%d", tr), "canSeek": true, "canNext": true, "canPrev": true},
					{"id": "com.github.th-ch.youtube-music", "title": "Gymnopédie No. 1", "artist": "示範鋼琴獨奏", "album": "Demo", "status": "Paused", "pos": 12, "dur": 210, "art": "demo2", "canSeek": true, "canNext": true, "canPrev": true},
				}})
			}
			p := make([]float64, 8)
			if playing {
				base := 0.35 + 0.25*math.Sin(float64(n)/7)
				for i := range p {
					g := 1.0
					if i == 2 || i == 3 || i == 4 || i == 5 {
						g = 0.0
					}
					if i >= 6 {
						g = 0.5
					}
					p[i] = math.Round(math.Max(0, math.Min(1, g*(base+rand.Float64()*0.3)))*1000) / 1000
				}
			}
			emit(map[string]any{"t": "meter", "p": p})
			if n%50 == 0 {
				devices()
			}
		}
	}()
	d.devicesFn = devices
	return d
}

func (d *demoBridge) Send(cmd map[string]any) {
	c, _ := cmd["c"].(string)
	d.mu.Lock()
	switch c {
	case "toggle":
		d.playing = !d.playing
	case "play":
		d.playing = true
	case "pause":
		d.playing = false
	case "next":
		d.track = (d.track + 1) % len(demoTracks)
		d.pos = 0
	case "prev":
		if d.pos > 3 {
			d.pos = 0
		} else {
			d.track = (d.track + len(demoTracks) - 1) % len(demoTracks)
			d.pos = 0
		}
	case "seek":
		if v, ok := cmd["pos"].(float64); ok {
			d.pos = v
		}
	case "setdef":
		if v, ok := cmd["id"].(string); ok {
			d.def = v
		}
	}
	fn := d.devicesFn
	d.mu.Unlock()
	if c == "setdef" && fn != nil {
		fn()
	}
}

func (d *demoBridge) Close() {
	select {
	case <-d.stop:
	default:
		close(d.stop)
	}
}
