# Third-party software

Fono Console itself is MIT-licensed. It works together with the projects below.

| Project | Used for | License | How it is delivered |
|---|---|---|---|
| [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) by Jonas Thedering | System-wide audio processing (required) | GPL-2.0 | The release zip contains the official, unmodified installer in `bundled/` with its source URL and SHA-256 in `bundled/SOURCES.txt`. Source code: see the project page. |
| [YouTube Music desktop (pear-desktop)](https://github.com/pear-devs/pear-desktop) | YouTube Music library and playback | MIT | Downloaded by the setup wizard from GitHub Releases; the SHA-256 published by GitHub is verified before running it. |
| [AutoEq](https://github.com/jaakkopasanen/AutoEq) by Jaakko Pasanen | Headphone correction data | MIT | Read on demand from GitHub, cached locally. |
| [REW – Room EQ Wizard](https://www.roomeqwizard.com/) by John Mulcahy | Optional advanced measurement | Freeware, redistribution not permitted | Not bundled. The app links to the official site. |
| [Impulcifer](https://github.com/jaakkopasanen/Impulcifer) by Jaakko Pasanen | Method reference for the planned binaural / virtual-speaker features | MIT | No code bundled yet; credited where its approach is used. |
| Spotify Web API | Library search and playback | Spotify Developer Terms | Each user registers their own developer app. |

Spotify and YouTube are trademarks of their owners. This project is not affiliated with them.
