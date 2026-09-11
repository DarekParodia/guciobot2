// Hand-written OpenAPI 3.1 description of the HTTP management API, served
// verbatim at GET /api/openapi.json so tools like Swagger UI can render it.
// Keep in sync with src/api/music.ts and docs/API.md — per RULES.md, all
// three must change together with any endpoint change.
export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'guciobot management API',
    version: '1.0.0',
    description:
        'HTTP control surface for the guciobot Discord bot. Mirrors the music slash commands. No authentication — bound to localhost by default.',
  },
  servers: [{url: 'http://127.0.0.1:8787'}],
  tags: [
    {name: 'meta', description: 'Liveness and machine-readable spec.'},
    {name: 'music', description: 'Music queue and playback control.'},
  ],
  components: {
    schemas: {
      Video: {
        type: 'object',
        required: ['url', 'title', 'duration', 'durationString'],
        properties: {
          url: {type: 'string', description: 'Canonical YouTube URL.'},
          title: {type: 'string'},
          duration: {type: 'number', description: 'Length in seconds.'},
          durationString: {type: 'string', examples: ['3m 33s']},
          startSeconds: {
            type: 'number',
            description: 'Seek offset in seconds; present only when requested.',
          },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {error: {type: 'string'}},
      },
      PlayBody: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {type: 'string', description: 'YouTube video or playlist URL.'},
          start: {
            type: 'string',
            description:
                'Start timestamp like "1:23" or "83". Single-song adds only; invalid values are silently ignored.',
          },
          voiceChannelId: {
            type: 'string',
            description:
                'Discord voice channel ID to join when the bot is not connected to voice.',
          },
        },
      },
    },
  },
  paths: {
    '/api/health': {
      get: {
        operationId: 'getHealth',
        tags: ['meta'],
        summary: 'Liveness check.',
        responses: {
          '200': {
            description: 'The API process is up.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'uptimeSeconds'],
                  properties: {
                    status: {type: 'string', const: 'ok'},
                    uptimeSeconds: {type: 'integer'},
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/nowplaying': {
      get: {
        operationId: 'getNowPlaying',
        tags: ['music'],
        summary: 'What the player is doing right now.',
        responses: {
          '200': {
            description: 'Current player status and video (null when idle).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'video'],
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['idle', 'buffering', 'playing', 'paused'],
                    },
                    video: {
                      oneOf: [
                        {$ref: '#/components/schemas/Video'},
                        {type: 'null'},
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/queue': {
      get: {
        operationId: 'getQueue',
        tags: ['music'],
        summary: 'The pending queue, in play order.',
        responses: {
          '200': {
            description: 'Queued videos (excluding the currently playing one).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['size', 'videos'],
                  properties: {
                    size: {type: 'integer'},
                    videos: {
                      type: 'array',
                      items: {$ref: '#/components/schemas/Video'},
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/play': {
      post: {
        operationId: 'play',
        tags: ['music'],
        summary:
            'Resolve a YouTube URL and append it to the queue, starting playback if idle.',
        description:
            'Playlists are expanded in order up to the queue cap of 100; videos past the cap are counted in `skipped`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {$ref: '#/components/schemas/PlayBody'},
            },
          },
        },
        responses: {
          '202': {
            description: 'Songs queued.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['added', 'skipped', 'queueSize'],
                  properties: {
                    added: {
                      type: 'array',
                      items: {$ref: '#/components/schemas/Video'},
                    },
                    skipped: {type: 'integer'},
                    queueSize: {type: 'integer'},
                  },
                },
              },
            },
          },
          '400': {
            description:
                'Missing url ("Pole \\"url\\" jest wymagane."), unresolvable link ("Nie udało się rozpoznać linku (yt-dlp)."), or malformed JSON ("Nieprawidłowy JSON.").',
            content: {
              'application/json': {
                schema: {$ref: '#/components/schemas/Error'},
              },
            },
          },
          '409': {
            description:
                'Not connected to voice and no voiceChannelId given ("Bot nie jest połączony z kanałem głosowym — podaj voiceChannelId.").',
            content: {
              'application/json': {
                schema: {$ref: '#/components/schemas/Error'},
              },
            },
          },
          '502': {
            description:
                'Voice join failed ("Nie udało się połączyć z kanałem głosowym.").',
            content: {
              'application/json': {
                schema: {$ref: '#/components/schemas/Error'},
              },
            },
          },
        },
      },
    },
    '/api/music/playnext': {
      post: {
        operationId: 'playNext',
        tags: ['music'],
        summary: 'Like /play, but inserts at the head of the queue.',
        description:
            'Playlist order is preserved within the inserted block. Body and errors identical to /api/music/play.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {$ref: '#/components/schemas/PlayBody'},
            },
          },
        },
        responses: {
          '202': {
            $ref: '#/paths/~1api~1music~1play/post/responses/202',
          },
          '400': {
            $ref: '#/paths/~1api~1music~1play/post/responses/400',
          },
          '409': {
            $ref: '#/paths/~1api~1music~1play/post/responses/409',
          },
          '502': {
            $ref: '#/paths/~1api~1music~1play/post/responses/502',
          },
        },
      },
    },
    '/api/music/skip': {
      post: {
        operationId: 'skip',
        tags: ['music'],
        summary: 'Skip the currently playing song.',
        responses: {
          '200': {
            description:
                'Reports the interrupted video, what plays next, and the resulting player status.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['skipped', 'nowPlaying', 'status'],
                  properties: {
                    skipped: {
                      oneOf: [
                        {$ref: '#/components/schemas/Video'},
                        {type: 'null'},
                      ],
                    },
                    nowPlaying: {
                      oneOf: [
                        {$ref: '#/components/schemas/Video'},
                        {type: 'null'},
                      ],
                    },
                    status: {
                      type: 'string',
                      enum: ['idle', 'buffering', 'playing', 'paused'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/shuffle': {
      post: {
        operationId: 'shuffle',
        tags: ['music'],
        summary: 'Shuffle the pending queue in place.',
        responses: {
          '200': {
            description: 'Queue shuffled.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['shuffled', 'size'],
                  properties: {
                    shuffled: {type: 'boolean', const: true},
                    size: {type: 'integer'},
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/clear': {
      post: {
        operationId: 'clear',
        tags: ['music'],
        summary: 'Empty the pending queue.',
        description: 'Does not stop the currently playing song.',
        responses: {
          '200': {
            description: 'Queue cleared.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['cleared', 'removed'],
                  properties: {
                    cleared: {type: 'boolean', const: true},
                    removed: {type: 'integer'},
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/music/pause': {
      post: {
        operationId: 'pause',
        tags: ['music'],
        summary: 'Pause playback.',
        responses: {
          '200': {
            description: 'Playback paused.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {status: {type: 'string', const: 'paused'}},
                },
              },
            },
          },
          '409': {
            description: 'Nothing is playing ("Nic nie jest odtwarzane.").',
            content: {
              'application/json': {
                schema: {$ref: '#/components/schemas/Error'},
              },
            },
          },
        },
      },
    },
    '/api/music/resume': {
      post: {
        operationId: 'resume',
        tags: ['music'],
        summary: 'Resume paused playback.',
        responses: {
          '200': {
            description: 'Playback resumed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {status: {type: 'string', const: 'playing'}},
                },
              },
            },
          },
          '409': {
            description:
                'Playback is not paused ("Odtwarzanie nie jest wstrzymane.").',
            content: {
              'application/json': {
                schema: {$ref: '#/components/schemas/Error'},
              },
            },
          },
        },
      },
    },
  },
} as const;
