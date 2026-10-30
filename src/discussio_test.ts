import { assertEquals } from "@std/assert";
import {
  animeEpisodeQuery,
  findEpisode,
  movieStreams,
  parseId,
  seriesEpisodeQuery,
  seriesStreams,
  splitSeason,
  type TitleInfo,
  toTitleInfo,
} from "./discussio.ts";

const query = (url: string) => new URL(url).searchParams.get("q");

Deno.test("parseId handles tt, colon schemes and movies", () => {
  assertEquals(parseId("series", "tt123:2:5"), {
    scheme: "tt",
    metaId: "tt123",
    season: 2,
    episode: 5,
  });
  assertEquals(parseId("series", "kitsu:46474:3"), {
    scheme: "kitsu",
    metaId: "kitsu:46474",
    season: 1,
    episode: 3,
  });
  assertEquals(parseId("series", "mal:52991:1:3")?.season, 1);
  assertEquals(parseId("movie", "tmdb:693134"), { scheme: "tmdb", metaId: "tmdb:693134" });
  assertEquals(parseId("movie", "tt5311514"), { scheme: "tt", metaId: "tt5311514" });
  assertEquals(parseId("series", "tt123"), null);
  assertEquals(parseId("series", "tt123:x:1"), null);
  assertEquals(parseId("series", "garbage"), null);
});

Deno.test("toTitleInfo prefers the English Kitsu alias even when it equals the name", () => {
  const aot = toTitleInfo(
    { name: "Attack on Titan", aliases: ["Attack on Titan", "Shingeki no Kyojin"] },
    "kitsu",
  );
  assertEquals(aot?.title, "Attack on Titan");
  const frieren = toTitleInfo(
    { name: "Sousou no Frieren", aliases: ["Frieren: Beyond Journey’s End", "Sousou no Frieren"] },
    "mal",
  );
  assertEquals(frieren?.title, "Frieren: Beyond Journey’s End");
  assertEquals(frieren?.anime, true);
});

Deno.test("toTitleInfo detects Japanese animation under tt ids", () => {
  const meta = { name: "X", genres: ["Animation"], country: "Japan, United States" };
  assertEquals(toTitleInfo(meta, "tt")?.anime, true);
  assertEquals(toTitleInfo({ ...meta, country: "United States" }, "tt")?.anime, false);
  assertEquals(toTitleInfo({ name: "X", year: "2023-2024" }, "tt")?.year, "2023");
});

Deno.test("splitSeason lifts Kitsu season suffixes", () => {
  assertEquals(splitSeason("Frieren: Beyond Journey's End Season 2"), {
    title: "Frieren: Beyond Journey's End",
    season: 2,
  });
  assertEquals(splitSeason("Sousou no Frieren 2nd Season"), {
    title: "Sousou no Frieren",
    season: 2,
  });
  assertEquals(splitSeason("One Piece"), { title: "One Piece" });
});

Deno.test("findEpisode computes absolute numbers and drops placeholder titles", () => {
  const info: TitleInfo = {
    title: "Show",
    anime: true,
    episodes: [[0, 1, "Special"], [1, 1, "Pilot"], [1, 2, "Episode 2"], [2, 1, "Return"]],
  };
  assertEquals(findEpisode(info, 2, 1), { title: "Return", absolute: 3 });
  assertEquals(findEpisode(info, 1, 2), { title: undefined, absolute: 2 });
  assertEquals(findEpisode(info, 0, 1), { title: "Special" });
  assertEquals(findEpisode(info, 9, 9), {});
});

Deno.test("anime queries quote r/anime's thread title format", () => {
  assertEquals(
    animeEpisodeQuery("Frieren", 1, 6),
    'Frieren "Episode 6 discussion" site:reddit.com/r/anime',
  );
  assertEquals(
    animeEpisodeQuery("Frieren", 2, 3, 31),
    'Frieren ("Season 2 - Episode 3 discussion" OR "Episode 31 discussion") site:reddit.com/r/anime',
  );
  assertEquals(
    animeEpisodeQuery("One Piece", 1, 1100, 1100),
    'One Piece "Episode 1100 discussion" site:reddit.com/r/anime',
  );
});

Deno.test("series queries include the episode title", () => {
  assertEquals(
    seriesEpisodeQuery("Severance", 1, 4, "The You You Are"),
    "Severance season 1 episode 4 The You You Are discussion site:reddit.com",
  );
  assertEquals(
    seriesEpisodeQuery("Severance", 0, 12, "Season 1 Recap"),
    "Severance Season 1 Recap discussion site:reddit.com",
  );
});

Deno.test("seriesStreams routes Kitsu season entries to the season phrase", () => {
  const info = toTitleInfo({
    name: "Sousou no Frieren 2nd Season",
    aliases: ["Frieren: Beyond Journey's End Season 2"],
    videos: [{ season: 1, episode: 3, title: "Somewhere She'd Like" }],
  }, "kitsu");
  const [s] = seriesStreams(parseId("series", "kitsu:49240:3")!, info);
  assertEquals(
    query(s.externalUrl),
    `Frieren: Beyond Journey's End "Season 2 - Episode 3 discussion" site:reddit.com/r/anime`,
  );
});

Deno.test("unroutable schemes get nothing; degraded known schemes get a fallback", () => {
  assertEquals(seriesStreams(parseId("series", "tmdb:1:1:1")!, null), []);
  assertEquals(seriesStreams(parseId("series", "imdb:1:1:1")!, null), []);
  assertEquals(movieStreams(parseId("movie", "someaddon:42")!, null), []);
  assertEquals(seriesStreams(parseId("series", "tt1:1:1")!, null).length, 1);
  assertEquals(movieStreams(parseId("movie", "kitsu:1")!, null).length, 1);
});

Deno.test("movieStreams: Letterboxd first for films, r/anime first for anime", () => {
  const film = movieStreams(
    parseId("movie", "tt15239678")!,
    { title: "Dune: Part Two", anime: false, year: "2024", episodes: [] },
  );
  assertEquals(film.map((s) => new URL(s.externalUrl).host), [
    "letterboxd.com",
    "www.google.com",
  ]);
  assertEquals(film[0].externalUrl, "https://letterboxd.com/imdb/tt15239678/");
  assertEquals(
    query(film[1].externalUrl),
    "Dune: Part Two (2024) official discussion site:reddit.com/r/movies",
  );

  const anime = movieStreams(
    parseId("movie", "kitsu:11614")!,
    { title: "Your Name.", anime: true, year: "2016", imdbId: "tt5311514", episodes: [] },
  );
  assertEquals(anime[1].externalUrl, "https://letterboxd.com/imdb/tt5311514/");
  assertEquals(
    query(anime[0].externalUrl),
    "Your Name. (2016) movie discussion site:reddit.com/r/anime",
  );

  assertEquals(
    movieStreams(parseId("movie", "tmdb:693134")!, null)[0].externalUrl,
    "https://letterboxd.com/tmdb/693134/",
  );
});
