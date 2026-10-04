<template>
  <div class="env-setup-panel">
    <div class="scroll-container">
      <LocalRunPlanner :key="plannerGeneration" v-if="runtimeMode !== 'cloud'"
        :plan="localPlan" :checking="planLoading" :waiting="waitingForCleanup" :busy="plannerBusy"
        :error="planError" :limits-valid="localLimitsValid" :can-prepare="canPrepareLocal" :can-reuse="canReuseLocal"
        :loading-cast="loadingCast" :catalog-loaded="catalogLoaded" :entities="catalog" :selected-ids="selectedEntityIds"
        :type-filter="typeFilter" :use-llm="useLlmProfiles" :complete="phase === 4"
        :max-rounds="localMaxRounds" :rounds-valid="localRoundsValid" :rounds-action="plannerActions.draftRoundsInput"
        :cancellation-status="cancellationStatus" :cancellation-blocked="cancellationBlocked"
        :show-cancel="showCancelPreparation" :can-cancel="canCancelPreparation" :cancel-retry="cancelRetry"
        :cancel-action="cancelPreparationAction"
        @refresh="plannerActions.refresh" @load="plannerActions.load" @select="plannerActions.select"
        @filter="plannerActions.filter" @profile-mode="plannerActions.profileMode"
        @prepare="plannerActions.prepare" @reuse="plannerActions.reuse" />
      <LocalCastPresetPanel v-if="runtimeMode === 'local'" :key="'preset-' + plannerGeneration"
        :catalog-ready="presetCatalogReady" :project-id="catalogSnapshot?.project_id" :graph-id="catalogSnapshot?.graph_id"
        :can-save="!!presetExport" :can-open="presetCanOpen" :reading="presetReading" :candidate="presetCandidate"
        :error="presetError" :compatibility-error="presetCompatibility.error" :can-apply="presetCanApply"
        :applied="presetApplied" :actions="presetActions" />
      <template v-if="runtimeMode === 'cloud' || phase > 0">
      <!-- Step 01: 模拟实例 -->
      <div class="step-card" :class="{ 'active': phase === 0, 'completed': phase > 0 }">
        <div class="card-header">
          <div class="step-info">
            <span class="step-num">01</span>
            <span class="step-title">{{ $t('step2.simInstanceInit') }}</span>
          </div>
          <div class="step-status">
            <span v-if="phase > 0" class="badge success">{{ $t('common.completed') }}</span>
            <span v-else class="badge processing">{{ $t('step2.initializing') }}</span>
          </div>
        </div>
        
        <div class="card-content">
          <p class="api-note">POST /api/simulation/create</p>
          <p class="description">
            {{ $t('step2.simInstanceDesc') }}
          </p>

          <div v-if="simulationId" class="info-card">
            <div class="info-row">
              <span class="info-label">Project ID</span>
              <span class="info-value mono">{{ projectData?.project_id }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Graph ID</span>
              <span class="info-value mono">{{ projectData?.graph_id }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Simulation ID</span>
              <span class="info-value mono">{{ simulationId }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Task ID</span>
              <span class="info-value mono">{{ taskId || $t('step2.asyncTaskDone') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 02: 生成 Agent 人设 -->
      <div class="step-card" :class="{ 'active': phase === 1, 'completed': phase > 1 }">
        <div class="card-header">
          <div class="step-info">
            <span class="step-num">02</span>
            <span class="step-title">{{ $t('step2.generateAgentPersona') }}</span>
          </div>
          <div class="step-status">
            <span v-if="phase > 1" class="badge success">{{ $t('common.completed') }}</span>
            <span v-else-if="phase === 1" class="badge processing">{{ prepareProgress }}%</span>
            <span v-else class="badge pending">{{ $t('common.pending') }}</span>
          </div>
        </div>

        <div class="card-content">
          <p class="api-note">POST /api/simulation/prepare</p>
          <p class="description">
            {{ $t('step2.generateAgentPersonaDesc') }}
          </p>

          <!-- Profiles Stats -->
          <div v-if="profiles.length > 0" class="stats-grid">
            <div class="stat-card">
              <span class="stat-value">{{ profiles.length }}</span>
              <span class="stat-label">{{ $t('step2.currentAgentCount') }}</span>
            </div>
            <div class="stat-card">
              <span class="stat-value">{{ expectedTotal || '-' }}</span>
              <span class="stat-label">{{ $t('step2.expectedAgentTotal') }}</span>
            </div>
            <div class="stat-card">
              <span class="stat-value">{{ totalTopicsCount }}</span>
              <span class="stat-label">{{ $t('step2.relatedTopicsCount') }}</span>
            </div>
          </div>

          <!-- Profiles List Preview -->
          <div v-if="profiles.length > 0" class="profiles-preview">
            <div class="preview-header">
              <span class="preview-title">{{ $t('step2.generatedAgentPersonas') }}</span>
            </div>
            <div class="profiles-list">
              <div 
                v-for="(profile, idx) in profiles" 
                :key="idx" 
                class="profile-card"
                @click="selectProfile(profile)"
              >
                <div class="profile-header">
                  <span class="profile-realname">{{ profile.username || 'Unknown' }}</span>
                  <span class="profile-username">@{{ profile.name || `agent_${idx}` }}</span>
                </div>
                <div class="profile-meta">
                  <span class="profile-profession">{{ profile.profession || $t('step2.unknownProfession') }}</span>
                </div>
                <p class="profile-bio">{{ profile.bio || $t('step2.noBio') }}</p>
                <div v-if="profile.interested_topics?.length" class="profile-topics">
                  <span 
                    v-for="topic in profile.interested_topics.slice(0, 3)" 
                    :key="topic" 
                    class="topic-tag"
                  >{{ topic }}</span>
                  <span v-if="profile.interested_topics.length > 3" class="topic-more">
                    +{{ profile.interested_topics.length - 3 }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 03: 生成双平台模拟配置 -->
      <div class="step-card" :class="{ 'active': phase === 2, 'completed': phase > 2 }">
        <div class="card-header">
          <div class="step-info">
            <span class="step-num">03</span>
            <span class="step-title">{{ $t('step2.dualPlatformConfig') }}</span>
          </div>
          <div class="step-status">
            <span v-if="phase > 2" class="badge success">{{ $t('common.completed') }}</span>
            <span v-else-if="phase === 2" class="badge processing">{{ $t('step2.generating') }}</span>
            <span v-else class="badge pending">{{ $t('common.pending') }}</span>
          </div>
        </div>

        <div class="card-content">
          <p class="api-note">POST /api/simulation/prepare</p>
          <p class="description">
            {{ $t('step2.dualPlatformConfigDesc') }}
          </p>
          
          <!-- Config Preview -->
          <div v-if="simulationConfig" class="config-detail-panel">
            <!-- 时间配置 -->
            <div v-if="runtimeMode !== 'local' || configuredRounds(simulationConfig) !== null" class="config-block">
              <div class="config-grid">
                <div class="config-item">
                  <span class="config-item-label">{{ $t('step2.simulationDuration') }}</span>
                  <span class="config-item-value">{{ simulationConfig.time_config?.total_simulation_hours || '-' }} {{ $t('common.hours') }}</span>
                </div>
                <div class="config-item">
                  <span class="config-item-label">{{ $t('step2.roundDuration') }}</span>
                  <span class="config-item-value">{{ simulationConfig.time_config?.minutes_per_round || '-' }} {{ $t('common.minutes') }}</span>
                </div>
                <div class="config-item">
                  <span class="config-item-label">{{ $t('step2.totalRounds') }}</span>
                  <span class="config-item-value">{{ Math.floor((simulationConfig.time_config?.total_simulation_hours * 60 / simulationConfig.time_config?.minutes_per_round)) || '-' }} {{ $t('common.rounds') }}</span>
                </div>
                <div class="config-item">
                  <span class="config-item-label">{{ $t('step2.activePerHour') }}</span>
                  <span class="config-item-value">{{ simulationConfig.time_config?.agents_per_hour_min }}-{{ simulationConfig.time_config?.agents_per_hour_max }}</span>
                </div>
              </div>
              <div class="time-periods">
                <div class="period-item">
                  <span class="period-label">{{ $t('step2.peakHours') }}</span>
                  <span class="period-hours">{{ simulationConfig.time_config?.peak_hours?.join(':00, ') }}:00</span>
                  <span class="period-multiplier">×{{ simulationConfig.time_config?.peak_activity_multiplier }}</span>
                </div>
                <div class="period-item">
                  <span class="period-label">{{ $t('step2.workHours') }}</span>
                  <span class="period-hours">{{ simulationConfig.time_config?.work_hours?.[0] }}:00-{{ simulationConfig.time_config?.work_hours?.slice(-1)[0] }}:00</span>
                  <span class="period-multiplier">×{{ simulationConfig.time_config?.work_activity_multiplier }}</span>
                </div>
                <div class="period-item">
                  <span class="period-label">{{ $t('step2.morningHours') }}</span>
                  <span class="period-hours">{{ simulationConfig.time_config?.morning_hours?.[0] }}:00-{{ simulationConfig.time_config?.morning_hours?.slice(-1)[0] }}:00</span>
                  <span class="period-multiplier">×{{ simulationConfig.time_config?.morning_activity_multiplier }}</span>
                </div>
                <div class="period-item">
                  <span class="period-label">{{ $t('step2.offPeakHours') }}</span>
                  <span class="period-hours">{{ simulationConfig.time_config?.off_peak_hours?.[0] }}:00-{{ simulationConfig.time_config?.off_peak_hours?.slice(-1)[0] }}:00</span>
                  <span class="period-multiplier">×{{ simulationConfig.time_config?.off_peak_activity_multiplier }}</span>
                </div>
              </div>
            </div>

            <!-- Agent 配置 -->
            <div class="config-block">
              <div class="config-block-header">
                <span class="config-block-title">{{ $t('step2.agentConfig') }}</span>
                <span class="config-block-badge">{{ simulationConfig.agent_configs?.length || 0 }} {{ $t('common.items') }}</span>
              </div>
              <div class="agents-cards">
                <div 
                  v-for="agent in simulationConfig.agent_configs" 
                  :key="agent.agent_id" 
                  class="agent-card"
                >
                  <!-- 卡片头部 -->
                  <div class="agent-card-header">
                    <div class="agent-identity">
                      <span class="agent-id">Agent {{ agent.agent_id }}</span>
                      <span class="agent-name">{{ agent.entity_name }}</span>
                    </div>
                    <div class="agent-tags">
                      <span class="agent-type">{{ agent.entity_type }}</span>
                      <span class="agent-stance" :class="'stance-' + agent.stance">{{ agent.stance }}</span>
                    </div>
                  </div>
                  
                  <!-- 活跃时间轴 -->
                  <div class="agent-timeline">
                    <span class="timeline-label">{{ $t('step2.activeTimePeriod') }}</span>
                    <div class="mini-timeline">
                      <div 
                        v-for="hour in 24" 
                        :key="hour - 1" 
                        class="timeline-hour"
                        :class="{ 'active': agent.active_hours?.includes(hour - 1) }"
                        :title="`${hour - 1}:00`"
                      ></div>
                    </div>
                    <div class="timeline-marks">
                      <span>0</span>
                      <span>6</span>
                      <span>12</span>
                      <span>18</span>
                      <span>24</span>
                    </div>
                  </div>

                  <!-- 行为参数 -->
                  <div class="agent-params">
                    <div class="param-group">
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.postsPerHour') }}</span>
                        <span class="param-value">{{ agent.posts_per_hour }}</span>
                      </div>
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.commentsPerHour') }}</span>
                        <span class="param-value">{{ agent.comments_per_hour }}</span>
                      </div>
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.responseDelay') }}</span>
                        <span class="param-value">{{ agent.response_delay_min }}-{{ agent.response_delay_max }}min</span>
                      </div>
                    </div>
                    <div class="param-group">
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.activityLevel') }}</span>
                        <span class="param-value with-bar">
                          <span class="mini-bar" :style="{ width: (agent.activity_level * 100) + '%' }"></span>
                          {{ (agent.activity_level * 100).toFixed(0) }}%
                        </span>
                      </div>
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.sentimentBias') }}</span>
                        <span class="param-value" :class="agent.sentiment_bias > 0 ? 'positive' : agent.sentiment_bias < 0 ? 'negative' : 'neutral'">
                          {{ agent.sentiment_bias > 0 ? '+' : '' }}{{ agent.sentiment_bias?.toFixed(1) }}
                        </span>
                      </div>
                      <div class="param-item">
                        <span class="param-label">{{ $t('step2.influenceWeight') }}</span>
                        <span class="param-value highlight">{{ agent.influence_weight?.toFixed(1) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 平台配置 -->
            <div class="config-block">
              <div class="config-block-header">
                <span class="config-block-title">{{ $t('step2.recommendAlgoConfig') }}</span>
              </div>
              <div class="platforms-grid">
                <div v-if="simulationConfig.twitter_config" class="platform-card">
                  <div class="platform-card-header">
                    <span class="platform-name">{{ $t('step2.platform1Name') }}</span>
                  </div>
                  <div class="platform-params">
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.recencyWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.twitter_config.recency_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.popularityWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.twitter_config.popularity_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.relevanceWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.twitter_config.relevance_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.viralThreshold') }}</span>
                      <span class="param-value">{{ simulationConfig.twitter_config.viral_threshold }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.echoChamberStrength') }}</span>
                      <span class="param-value">{{ simulationConfig.twitter_config.echo_chamber_strength }}</span>
                    </div>
                  </div>
                </div>
                <div v-if="simulationConfig.reddit_config" class="platform-card">
                  <div class="platform-card-header">
                    <span class="platform-name">{{ $t('step2.platform2Name') }}</span>
                  </div>
                  <div class="platform-params">
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.recencyWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.reddit_config.recency_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.popularityWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.reddit_config.popularity_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.relevanceWeight') }}</span>
                      <span class="param-value">{{ simulationConfig.reddit_config.relevance_weight }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.viralThreshold') }}</span>
                      <span class="param-value">{{ simulationConfig.reddit_config.viral_threshold }}</span>
                    </div>
                    <div class="param-row">
                      <span class="param-label">{{ $t('step2.echoChamberStrength') }}</span>
                      <span class="param-value">{{ simulationConfig.reddit_config.echo_chamber_strength }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- LLM 配置推理 -->
            <div v-if="simulationConfig.generation_reasoning" class="config-block">
              <div class="config-block-header">
                <span class="config-block-title">{{ $t('step2.llmConfigReasoning') }}</span>
              </div>
              <div class="reasoning-content">
                <div 
                  v-for="(reason, idx) in simulationConfig.generation_reasoning.split('|').slice(0, 2)" 
                  :key="idx" 
                  class="reasoning-item"
                >
                  <p class="reasoning-text">{{ reason.trim() }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 04: 初始激活编排 -->
      <div class="step-card" :class="{ 'active': phase === 3, 'completed': phase > 3 }">
        <div class="card-header">
          <div class="step-info">
            <span class="step-num">04</span>
            <span class="step-title">{{ $t('step2.initialActivation') }}</span>
          </div>
          <div class="step-status">
            <span v-if="phase > 3" class="badge success">{{ $t('common.completed') }}</span>
            <span v-else-if="phase === 3" class="badge processing">{{ $t('step2.orchestrating') }}</span>
            <span v-else class="badge pending">{{ $t('common.pending') }}</span>
          </div>
        </div>

        <div class="card-content">
          <p class="api-note">POST /api/simulation/prepare</p>
          <p class="description">
            {{ $t('step2.initialActivationDesc') }}
          </p>

          <div v-if="simulationConfig?.event_config" class="orchestration-content">
            <!-- 叙事方向 -->
            <div class="narrative-box">
              <span class="box-label narrative-label">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="special-icon">
                  <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="url(#paint0_linear)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M16.24 7.76L14.12 14.12L7.76 16.24L9.88 9.88L16.24 7.76Z" fill="url(#paint0_linear)" stroke="url(#paint0_linear)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <defs>
                    <linearGradient id="paint0_linear" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                      <stop stop-color="#FF5722"/>
                      <stop offset="1" stop-color="#FF9800"/>
                    </linearGradient>
                  </defs>
                </svg>
                {{ $t('step2.narrativeDirection') }}
              </span>
              <p class="narrative-text">{{ simulationConfig.event_config.narrative_direction }}</p>
            </div>

            <!-- 热点话题 -->
            <div class="topics-section">
              <span class="box-label">{{ $t('step2.initialHotTopics') }}</span>
              <div class="hot-topics-grid">
                <span v-for="topic in simulationConfig.event_config.hot_topics" :key="topic" class="hot-topic-tag">
                  # {{ topic }}
                </span>
              </div>
            </div>

            <!-- 初始帖子流 -->
            <div class="initial-posts-section">
              <span class="box-label">{{ $t('step2.initialActivationSeq', { count: simulationConfig.event_config.initial_posts.length }) }}</span>
              <div class="posts-timeline">
                <div v-for="(post, idx) in simulationConfig.event_config.initial_posts" :key="idx" class="timeline-item">
                  <div class="timeline-marker"></div>
                  <div class="timeline-content">
                    <div class="post-header">
                      <span class="post-role">{{ post.poster_type }}</span>
                      <span class="post-agent-info">
                        <span class="post-id">Agent {{ post.poster_agent_id }}</span>
                        <span class="post-username">@{{ getAgentUsername(post.poster_agent_id) }}</span>
                      </span>
                    </div>
                    <p class="post-text">{{ post.content }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      </template>
      <!-- Step 05: 准备完成 -->
      <div class="step-card" :class="{ 'active': phase === 4 }">
        <div class="card-header">
          <div class="step-info">
            <span class="step-num">05</span>
            <span class="step-title">{{ $t('step2.setupComplete') }}</span>
          </div>
          <div class="step-status">
            <span v-if="phase >= 4" class="badge processing">{{ $t('step1.inProgress') }}</span>
            <span v-else class="badge pending">{{ $t('common.pending') }}</span>
          </div>
        </div>

        <div class="card-content">
          <p class="api-note">POST /api/simulation/start</p>
          <p class="description">{{ $t('step2.setupCompleteDesc') }}</p>
          
          <!-- 模拟轮数配置 - 只有在配置生成完成且轮数计算出来后才显示 -->
          <div v-if="runtimeMode === 'local' && phase === 4" class="rounds-config-section local-rounds">
            <label for="local-maximum-rounds">{{ $t('localPlan.maximumRounds') }}</label>
            <input id="local-maximum-rounds" data-testid="maximum-rounds" type="number" min="1" step="1"
              :max="localPlan?.limits?.max_rounds" :value="localMaxRounds" :onInput="plannerActions.roundsInput">
            <p>{{ $t('localPlan.roundsHint', { cap: localPlan?.limits?.max_rounds }) }}</p>
            <p v-if="effectiveLocalRounds !== null">{{ $t('localPlan.effectiveRounds', { rounds: effectiveLocalRounds }) }}</p>
            <p v-else>{{ $t(localRoundsValid ? 'localPlan.configuredUnknown' : 'localPlan.invalidRounds') }}</p>
          </div>
          <div v-if="runtimeMode === 'cloud' && simulationConfig && autoGeneratedRounds" class="rounds-config-section">
            <div class="rounds-header">
              <div class="header-left">
                <span class="section-title">{{ $t('step2.roundsConfig') }}</span>
                <span class="section-desc">{{ $t('step2.roundsConfigDesc', { hours: simulationConfig?.time_config?.total_simulation_hours || '-', minutesPerRound: simulationConfig?.time_config?.minutes_per_round || '-' }) }}</span>
              </div>
              <label class="switch-control">
                <input type="checkbox" v-model="useCustomRounds">
                <span class="switch-track"></span>
                <span class="switch-label">{{ $t('step2.customToggle') }}</span>
              </label>
            </div>
            
            <Transition name="fade" mode="out-in">
              <div v-if="useCustomRounds" class="rounds-content custom" key="custom">
                <div class="slider-display">
                  <div class="slider-main-value">
                    <span class="val-num">{{ customMaxRounds }}</span>
                    <span class="val-unit">{{ $t('step2.roundsUnit') }}</span>
                  </div>
                  <div class="slider-meta-info">
                    <span>{{ $t('step2.estimatedDuration', { minutes: Math.round(customMaxRounds * 0.6) }) }}</span>
                  </div>
                </div>

                <div class="range-wrapper">
                  <input 
                    type="range" 
                    v-model.number="customMaxRounds" 
                    min="10" 
                    :max="autoGeneratedRounds"
                    step="5"
                    class="minimal-slider"
                    :style="{ '--percent': ((customMaxRounds - 10) / (autoGeneratedRounds - 10)) * 100 + '%' }"
                  />
                  <div class="range-marks">
                    <span>10</span>
                    <span 
                      class="mark-recommend" 
                      :class="{ active: customMaxRounds === 40 }"
                      @click="customMaxRounds = 40"
                      :style="{ position: 'absolute', left: `calc(${(40 - 10) / (autoGeneratedRounds - 10) * 100}% - 30px)` }"
                    >{{ $t('step2.recommendedRounds', { rounds: 40 }) }}</span>
                    <span>{{ autoGeneratedRounds }}</span>
                  </div>
                </div>
              </div>
              
              <div v-else class="rounds-content auto" key="auto">
                <div class="auto-info-card">
                  <div class="auto-value">
                    <span class="val-num">{{ autoGeneratedRounds }}</span>
                    <span class="val-unit">{{ $t('step2.roundsUnit') }}</span>
                  </div>
                  <div class="auto-content">
                    <div class="auto-meta-row">
                      <span class="duration-badge">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        {{ $t('step2.estimatedDurationFull', { minutes: Math.round(autoGeneratedRounds * 0.6) }) }}
                      </span>
                    </div>
                    <div class="auto-desc">
                      <p class="highlight-tip" @click="useCustomRounds = true">{{ $t('step2.customTip') }} ➝</p>
                    </div>
                  </div>
                </div>
              </div>
            </Transition>
          </div>

          <div class="action-group dual">
            <button 
              class="action-btn secondary"
              :onClick="plannerActions.back"
            >
              ← {{ $t('step2.backToGraphBuild') }}
            </button>
            <button 
              class="action-btn primary"
              :disabled="phase < 4 || cancellationBlocked || cancelPending || (runtimeMode === 'local' && !localRoundsValid)"
              :onClick="plannerActions.start"
            >
              {{ $t('step2.startDualWorldSim') }} ➝
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Profile Detail Modal -->
    <Transition name="modal">
      <div v-if="selectedProfile" class="profile-modal-overlay" @click.self="selectedProfile = null">
        <div class="profile-modal">
          <div class="modal-header">
          <div class="modal-header-info">
            <div class="modal-name-row">
              <span class="modal-realname">{{ selectedProfile.username }}</span>
              <span class="modal-username">@{{ selectedProfile.name }}</span>
            </div>
            <span class="modal-profession">{{ selectedProfile.profession }}</span>
          </div>
          <button class="close-btn" @click="selectedProfile = null">×</button>
        </div>
        
        <div class="modal-body">
          <!-- 基本信息 -->
          <div class="modal-info-grid">
            <div class="info-item">
              <span class="info-label">{{ $t('step2.profileModalAge') }}</span>
              <span class="info-value">{{ selectedProfile.age || '-' }} {{ $t('step2.yearsOld') }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">{{ $t('step2.profileModalGender') }}</span>
              <span class="info-value">{{ { male: $t('step2.genderMale'), female: $t('step2.genderFemale'), other: $t('step2.genderOther') }[selectedProfile.gender] || selectedProfile.gender }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">{{ $t('step2.profileModalCountry') }}</span>
              <span class="info-value">{{ selectedProfile.country || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">{{ $t('step2.profileModalMbti') }}</span>
              <span class="info-value mbti">{{ selectedProfile.mbti || '-' }}</span>
            </div>
          </div>

          <!-- 简介 -->
          <div class="modal-section">
            <span class="section-label">{{ $t('step2.profileModalBio') }}</span>
            <p class="section-bio">{{ selectedProfile.bio || $t('step2.noBio') }}</p>
          </div>

          <!-- 关注话题 -->
          <div class="modal-section" v-if="selectedProfile.interested_topics?.length">
            <span class="section-label">{{ $t('step2.profileModalTopics') }}</span>
            <div class="topics-grid">
              <span 
                v-for="topic in selectedProfile.interested_topics" 
                :key="topic" 
                class="topic-item"
              >{{ topic }}</span>
            </div>
          </div>

          <!-- 详细人设 -->
          <div class="modal-section" v-if="selectedProfile.persona">
            <span class="section-label">{{ $t('step2.profileModalPersona') }}</span>
            
            <!-- 人设维度概览 -->
            <div class="persona-dimensions">
              <div class="dimension-card">
                <span class="dim-title">{{ $t('step2.personaDimExperience') }}</span>
                <span class="dim-desc">{{ $t('step2.personaDimExperienceDesc') }}</span>
              </div>
              <div class="dimension-card">
                <span class="dim-title">{{ $t('step2.personaDimBehavior') }}</span>
                <span class="dim-desc">{{ $t('step2.personaDimBehaviorDesc') }}</span>
              </div>
              <div class="dimension-card">
                <span class="dim-title">{{ $t('step2.personaDimMemory') }}</span>
                <span class="dim-desc">{{ $t('step2.personaDimMemoryDesc') }}</span>
              </div>
              <div class="dimension-card">
                <span class="dim-title">{{ $t('step2.personaDimSocial') }}</span>
                <span class="dim-desc">{{ $t('step2.personaDimSocialDesc') }}</span>
              </div>
            </div>

            <div class="persona-content">
              <p class="section-persona">{{ selectedProfile.persona }}</p>
            </div>
          </div>
        </div>
      </div>
      </div>
    </Transition>

    <!-- Bottom Info / Logs -->
    <div class="system-logs">
      <div class="log-header">
        <span class="log-title">SYSTEM DASHBOARD</span>
        <span class="log-id">{{ simulationId || 'NO_SIMULATION' }}</span>
      </div>
      <div class="log-content" ref="logContent">
        <div class="log-line" v-for="(log, idx) in systemLogs" :key="idx">
          <span class="log-time">{{ log.time }}</span>
          <span class="log-msg">{{ log.msg }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import LocalRunPlanner from './LocalRunPlanner.vue'
import LocalCastPresetPanel from './LocalCastPresetPanel.vue'
import { LOCAL_CAST_PRESET_MAX_BYTES, parseLocalCastPresetBytes, exportLocalCastPreset, validLocalCastPresetCatalog, acceptCompatibleLocalCastPreset } from '../utils/localCastPreset'
import { validLocalPlan, validLocalCatalog, validPreparationTask, configuredRounds, validLocalMaximum, effectiveRounds, planningErrorKey } from '../utils/localRunPlan'
import {
  prepareSimulation,
  cancelPreparation,
  getPreparationPlan,
  previewPreparation,
  getPrepareStatus,
  getSimulationProfilesRealtime,
  getSimulationConfigRealtime
} from '../api/simulation'

const { t } = useI18n()

const props = defineProps({
  simulationId: String,  // 从父组件传入
  cleanupReady: { type: Boolean, default: true },
  projectData: Object,
  graphData: Object,
  systemLogs: Array
})

const emit = defineEmits(['go-back', 'next-step', 'add-log', 'update-status', 'runtime-mode'])

// State
const phase = ref(0) // 0: 初始化, 1: 生成人设, 2: 生成配置, 3: 完成
const taskId = ref(null)
const prepareProgress = ref(0)
const currentStage = ref('')
const progressMessage = ref('')
const profiles = ref([])
const entityTypes = ref([])
const expectedTotal = ref(null)
const simulationConfig = ref(null)
const selectedProfile = ref(null)
const showProfilesDetail = ref(true)

const plannerGeneration = ref(0)
const runtimeMode = ref('unknown')
const localPlan = ref(null)
const planLoading = ref(false)
const planError = ref('')
const loadingCast = ref(false)
const actionPending = ref(false)
const catalogLoaded = ref(false)
const catalog = ref([])
// The admitted preview owns the project/graph binding; parent metadata cannot
// authorize a portable preset for a different or stale graph.
const catalogSnapshot = ref(null)
const presetEpoch = ref(0)
const presetReading = ref(false)
const presetCandidate = ref(null)
const presetError = ref('')
const presetApplied = ref(false)
let presetDownloadUrl = null
const selectedEntityIds = ref([])
const typeFilter = ref('')
const useLlmProfiles = ref(false)
const localMaxRounds = ref(null)
const plannerActions = ref({})
const preparationTask = ref(null)
const cancellationBlocked = ref(false)
const cancelPending = ref(false)
const cancelNeedsObservation = ref(false)
const cancelRetry = ref(false)
const cancelFeedback = ref('')
const cancellationStatus = computed(() => {
  if (cancelPending.value) return 'localPlan.cancelPending'
  if (cancelFeedback.value) return cancelFeedback.value
  const stage = preparationTask.value?.preparation_phase
  return ({ preparing: 'localPlan.preparationActive', cancelling: 'localPlan.cancelling', finalizing: 'localPlan.finalizing',
    cancelled: 'localPlan.cancelled', unavailable: 'localPlan.cancelUnavailable' })[stage]
    || (cancellationBlocked.value ? 'localPlan.cancelUnavailable' : '')
})
const showCancelPreparation = computed(() => runtimeMode.value === 'local'
  && validPreparationTask(preparationTask.value, props.simulationId, taskId.value)
  && preparationTask.value.preparation_phase === 'preparing' && preparationTask.value.can_cancel
  && !preparationTask.value.cancellation_requested && !cancellationBlocked.value)
const canCancelPreparation = computed(() => showCancelPreparation.value && !cancelPending.value && !cancelNeedsObservation.value)
// Pass this captured callback directly to the button. An old rendered handler
// must not pick up a replacement task through a mutable component event handler.
const cancelPreparationAction = computed(() => {
  const context = preparationContext, id = taskId.value
  return () => requestPreparationCancellation(context, id)
})
const localLimitsValid = computed(() => validLocalPlan(localPlan.value))
const waitingForCleanup = computed(() => runtimeMode.value === 'local' && !props.cleanupReady)
const plannerBusy = computed(() => planLoading.value || loadingCast.value || actionPending.value || cancelPending.value || (phase.value > 0 && phase.value < 4))
const canPrepareLocal = computed(() => runtimeMode.value === 'local' && props.cleanupReady && localLimitsValid.value
  && !cancellationBlocked.value && !plannerBusy.value && !planError.value && !localPlan.value.owner.busy && localPlan.value.can_prepare && !localPlan.value.prepared.available)
const canReuseLocal = computed(() => runtimeMode.value === 'local' && props.cleanupReady && localLimitsValid.value
  && !cancellationBlocked.value && !plannerBusy.value && !planError.value && !localPlan.value.owner.busy && localPlan.value.can_reuse && localPlan.value.prepared.available)
const localRoundsValid = computed(() => localLimitsValid.value && validLocalMaximum(localMaxRounds.value, localPlan.value?.limits?.max_rounds))
const effectiveLocalRounds = computed(() => effectiveRounds(simulationConfig.value, localMaxRounds.value, localPlan.value?.limits?.max_rounds))

// 日志去重：记录上一次输出的关键信息
let lastLoggedMessage = ''
let lastLoggedProfileCount = 0
let lastLoggedConfigStage = ''

// 模拟轮数配置
const useCustomRounds = ref(false) // 默认使用自动配置轮数
const customMaxRounds = ref(40)   // 默认推荐40轮

// Watch stage to update phase
watch(currentStage, (newStage) => {
  const context = preparationContext
  if (!isActive(context) || context.preparedConfirmed || cancellationBlocked.value) return
  if (newStage === '生成Agent人设' || newStage === 'generating_profiles') {
    phase.value = 1
  } else if (newStage === '生成模拟配置' || newStage === 'generating_config') {
    phase.value = 2
    // 进入配置生成阶段，开始轮询配置
    if (configTimer === null) {
      addLog(t('log.startGeneratingConfig'))
      startConfigPolling(context)
    }
  } else if (newStage === '准备模拟脚本' || newStage === 'copying_scripts') {
    phase.value = 2 // 仍属于配置阶段
  }
})

// 从配置中计算自动生成的轮数（不使用硬编码默认值）
const autoGeneratedRounds = computed(() => {
  if (!simulationConfig.value?.time_config) {
    return null // 配置未生成时返回 null
  }
  const totalHours = simulationConfig.value.time_config.total_simulation_hours
  const minutesPerRound = simulationConfig.value.time_config.minutes_per_round
  if (!totalHours || !minutesPerRound) {
    return null // 配置数据不完整时返回 null
  }
  const calculatedRounds = Math.floor((totalHours * 60) / minutesPerRound)
  if (runtimeMode.value === 'local') return configuredRounds(simulationConfig.value)
  // 确保最大轮数不小于40（推荐值），避免滑动条范围异常
  return Math.max(calculatedRounds, 40)
})

// Polling timer
let pollTimer = null
let profilesTimer = null
let configTimer = null


// One identity owns this selection, including A → B → A and its final reads.
let mounted = false
let preparationContext = null
const ownsView = context => !!context && mounted && context === preparationContext && props.simulationId === context.id
const isActive = context => ownsView(context) && !context.terminal
const ownsTask = (context, id) => isActive(context) && taskId.value === id

const singleFlight = (context, stream, operation) => {
  if (!isActive(context)) return Promise.resolve()
  if (context.requests[stream]) return context.requests[stream]
  const pending = Promise.resolve().then(() => {
    if (isActive(context)) return operation()
  }).finally(() => {
    if (context.requests[stream] === pending) delete context.requests[stream]
  })
  context.requests[stream] = pending
  return pending
}

const stopAllPolling = () => {
  stopPolling()
  stopProfilesPolling()
  stopConfigPolling()
}

const finishPreparation = (context, status) => {
  if (!isActive(context)) return
  context.terminal = status
  stopAllPolling()
  if (runtimeMode.value === 'local' && status === 'error') phase.value = 0
  // This retires HTTP observation only; backend preparation is not canceled.
  context.controller.abort()
  context.cancelController.abort()
  emit('update-status', status)
}

const replacePreparation = () => {
  if (preparationContext) { preparationContext.controller.abort(); preparationContext.cancelController.abort() }
  retirePreset()
  preparationContext = null
  stopAllPolling()
  plannerGeneration.value += 1
  runtimeMode.value = 'unknown'
  localPlan.value = null
  planLoading.value = false
  planError.value = ''
  loadingCast.value = false
  actionPending.value = false
  catalogLoaded.value = false
  catalog.value = []
  catalogSnapshot.value = null
  selectedEntityIds.value = []
  typeFilter.value = ''
  useLlmProfiles.value = false
  localMaxRounds.value = null
  plannerActions.value = {}
  preparationTask.value = null
  cancellationBlocked.value = false
  cancelPending.value = false
  cancelNeedsObservation.value = false
  cancelRetry.value = false
  cancelFeedback.value = ''
  phase.value = 0
  taskId.value = null
  prepareProgress.value = 0
  currentStage.value = ''
  progressMessage.value = ''
  profiles.value = []
  entityTypes.value = []
  expectedTotal.value = null
  simulationConfig.value = null
  selectedProfile.value = null
  showProfilesDetail.value = true
  useCustomRounds.value = false
  customMaxRounds.value = 40
  lastLoggedMessage = ''
  lastLoggedProfileCount = 0
  lastLoggedConfigStage = ''
  if (!mounted || !props.simulationId) return
  preparationContext = {
    id: props.simulationId, controller: new AbortController(), cancelController: new AbortController(), requests: {}, cancelEpoch: 0,
    terminal: null, preparedConfirmed: false,
  }
  addLog(t('log.step2Init'))
  const context = preparationContext
  plannerActions.value = {
    refresh: () => { if (ownsView(context) && !plannerBusy.value) replacePreparation() },
    load: () => loadLocalCast(context),
    select: (id, checked) => {
      if (!isActive(context) || !canPrepareLocal.value || !catalog.value.some(entity => entity.uuid === id)) return
      const selected = selectedEntityIds.value
      if (checked === true && !selected.includes(id) && selected.length < localPlan.value.limits.max_selectable_agents) selectedEntityIds.value = [...selected, id]
      else if (checked === false) selectedEntityIds.value = selected.filter(value => value !== id)
    },
    filter: value => { if (isActive(context) && !plannerBusy.value && typeof value === 'string') typeFilter.value = value },
    profileMode: value => { if (isActive(context) && canPrepareLocal.value && typeof value === 'boolean') useLlmProfiles.value = value },
    draftRoundsInput: event => {
      if (!isActive(context) || phase.value !== 0 || !canPrepareLocal.value) return
      const value = event.target.value
      localMaxRounds.value = value === '' ? null : Number(value)
    },
    roundsInput: event => {
      if (!ownsView(context) || runtimeMode.value !== 'local') return
      const value = event.target.value
      localMaxRounds.value = value === '' ? null : Number(value)
    },
    start: () => { if (ownsView(context)) handleStartSimulation() },
    back: () => { if (ownsView(context)) emit('go-back') },
    prepare: () => prepareLocal(context, false),
    reuse: () => prepareLocal(context, true),
  }
  emit('update-status', 'planning')
  resolvePreparationPlan(context)
}

// Import epochs are independent of route identity: a second file, clear, or
// catalog replacement retires every callback and outstanding file read.
const revokePresetDownload = () => {
  if (presetDownloadUrl !== null) URL.revokeObjectURL(presetDownloadUrl)
  presetDownloadUrl = null
}
const retirePreset = () => {
  presetEpoch.value += 1
  presetReading.value = false
  presetCandidate.value = null
  presetError.value = ''
  presetApplied.value = false
  revokePresetDownload()
}
const ownsPreset = (context, epoch, snapshot) => ownsView(context) && presetEpoch.value === epoch && catalogSnapshot.value === snapshot
const presetErrorKey = error => 'localCastPreset.errors.' + (['invalid_preset', 'file_too_large', 'invalid_utf8', 'invalid_catalog',
  'identity_mismatch', 'selection_unavailable', 'agent_limit_exceeded', 'round_limit_exceeded'].includes(error?.code) ? error.code : 'read_failed')
const presetCatalogReady = computed(() => runtimeMode.value === 'local' && validLocalCastPresetCatalog(catalogSnapshot.value, props.simulationId))
const presetCanOpen = computed(() => presetCatalogReady.value && !loadingCast.value)
const currentPresetCatalog = () => ({ ...catalogSnapshot.value, limits: localPlan.value?.limits })
const presetCompatibility = computed(() => {
  if (!presetCandidate.value) return { preset: null, error: '' }
  try { return { preset: acceptCompatibleLocalCastPreset(presetCandidate.value, currentPresetCatalog(), props.simulationId), error: '' } }
  catch (error) { return { preset: null, error: presetErrorKey(error) } }
})
const presetCanApply = computed(() => !!presetCompatibility.value.preset && phase.value === 0 && canPrepareLocal.value
  && isActive(preparationContext))
const presetExport = computed(() => {
  if (!presetCatalogReady.value) return null
  try {
    return exportLocalCastPreset(acceptCompatibleLocalCastPreset({ schema_version: 1, kind: 'mirofish_local_cast_preset',
      project_id: catalogSnapshot.value.project_id, graph_id: catalogSnapshot.value.graph_id,
      selected_entity_ids: [...selectedEntityIds.value], use_llm_for_profiles: useLlmProfiles.value,
      max_rounds: localMaxRounds.value }, currentPresetCatalog(), props.simulationId))
  } catch { return null }
})
const presetActions = computed(() => {
  // Read reactive generation as well as capturing the unique context identity.
  plannerGeneration.value
  const context = preparationContext, epoch = presetEpoch.value, snapshot = catalogSnapshot.value
  const capturedCandidate = presetCandidate.value, capturedExport = presetExport.value
  return {
    open: async event => {
      if (!ownsPreset(context, epoch, snapshot) || !presetCanOpen.value) return
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      retirePreset()
      const readEpoch = presetEpoch.value
      presetReading.value = true
      try {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LOCAL_CAST_PRESET_MAX_BYTES) throw { code: 'file_too_large' }
        const bytes = await file.arrayBuffer()
        if (!ownsPreset(context, readEpoch, snapshot)) return
        const accepted = parseLocalCastPresetBytes(bytes)
        if (!ownsPreset(context, readEpoch, snapshot)) return
        presetCandidate.value = accepted
      } catch (error) {
        if (ownsPreset(context, readEpoch, snapshot)) presetError.value = presetErrorKey(error)
      } finally {
        if (ownsPreset(context, readEpoch, snapshot)) presetReading.value = false
      }
    },
    clear: () => { if (ownsPreset(context, epoch, snapshot)) retirePreset() },
    apply: () => {
      if (!ownsPreset(context, epoch, snapshot) || !capturedCandidate || presetCandidate.value !== capturedCandidate || !presetCanApply.value) return
      let accepted
      try { accepted = acceptCompatibleLocalCastPreset(capturedCandidate, currentPresetCatalog(), context.id) }
      catch (error) { presetError.value = presetErrorKey(error); return }
      // Admission is complete before replacing any part of the draft.
      selectedEntityIds.value = [...accepted.selected_entity_ids]
      useLlmProfiles.value = accepted.use_llm_for_profiles
      localMaxRounds.value = accepted.max_rounds
      retirePreset()
      presetApplied.value = true
    },
    save: () => {
      if (!ownsPreset(context, epoch, snapshot) || !capturedExport || presetExport.value !== capturedExport) return
      revokePresetDownload()
      try {
        const blob = new Blob([capturedExport], { type: 'application/json;charset=utf-8' })
        presetDownloadUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = presetDownloadUrl
        link.download = 'mirofish-local-cast-preset.json'
        link.click()
      } catch {
        revokePresetDownload()
        presetError.value = 'localCastPreset.errors.download_failed'
      }
    },
  }
})

// Computed
const displayProfiles = computed(() => {
  if (showProfilesDetail.value) {
    return profiles.value
  }
  return profiles.value.slice(0, 6)
})

// 根据agent_id获取对应的username
const getAgentUsername = (agentId) => {
  if (profiles.value && profiles.value.length > agentId && agentId >= 0) {
    const profile = profiles.value[agentId]
    return profile?.username || `agent_${agentId}`
  }
  return `agent_${agentId}`
}

// 计算所有人设的关联话题总数
const totalTopicsCount = computed(() => {
  return profiles.value.reduce((sum, p) => {
    return sum + (p.interested_topics?.length || 0)
  }, 0)
})

// Methods
const addLog = (msg) => {
  emit('add-log', msg)
}

const handlePrepareFailure = (message, context = preparationContext) => {
  if (!isActive(context)) return
  if (runtimeMode.value === 'local') {
    planError.value = 'localPlan.requestError'
    addLog(t('localPlan.requestError'))
  } else addLog(t('log.prepareFailedWithError', { error: message || t('common.unknownError') }))
  finishPreparation(context, 'error')
}

// 处理开始模拟按钮点击
const handleStartSimulation = () => {
  if (!ownsView(preparationContext) || preparationContext.terminal !== 'completed' || cancellationBlocked.value || cancelPending.value) return
  // 构建传递给父组件的参数
  const params = {}
  
  if (runtimeMode.value === 'local') {
    if (!localRoundsValid.value) return
    params.maxRounds = localMaxRounds.value
  } else if (useCustomRounds.value) {
    // 用户自定义轮数，传递 max_rounds 参数
    params.maxRounds = customMaxRounds.value
    addLog(t('log.startSimCustomRounds', { rounds: customMaxRounds.value }))
  } else {
    // 用户选择保持自动生成的轮数，不传递 max_rounds 参数
    addLog(t('log.startSimAutoRounds', { rounds: autoGeneratedRounds.value }))
  }
  
  emit('next-step', params)
}

const truncateBio = (bio) => {
  if (bio.length > 80) {
    return bio.substring(0, 80) + '...'
  }
  return bio
}

const selectProfile = (profile) => {
  selectedProfile.value = profile
}

// Cancellation is authoritative before generic completed/ready handling. Keep
// the read controller alive while the worker drains and retires its resources.
const applyPreparationTask = (context, data) => {
  if (!ownsTask(context, data.task_id) || !validPreparationTask(data, context.id, taskId.value)) return false
  preparationTask.value = data
  const stage = data.preparation_phase
  if (data.cancellation_requested || data.status === 'cancelled' || ['cancelling', 'cancelled', 'unavailable'].includes(stage)) {
    cancellationBlocked.value = true
    simulationConfig.value = null
    stopConfigPolling()
    cancelFeedback.value = ''
  }
  if (stage === 'cancelled' || data.status === 'cancelled') {
    phase.value = 0
    cancelFeedback.value = 'localPlan.cancelled'
    finishPreparation(context, 'cancelled')
    return true
  }
  if (stage === 'cancelling' || stage === 'unavailable' || cancellationBlocked.value) {
    phase.value = 1
    emit('update-status', stage === 'unavailable' ? 'blocked' : 'processing')
    return true
  }
  if (['ready', 'failed'].includes(stage)) cancelFeedback.value = ''
  return false
}

const requestPreparationCancellation = async (context, id) => {
  if (!ownsTask(context, id) || !canCancelPreparation.value) return
  cancelPending.value = true
  cancelNeedsObservation.value = true
  cancelRetry.value = false
  cancelFeedback.value = ''
  const epoch = ++context.cancelEpoch
  try {
    const response = await cancelPreparation({ simulation_id: context.id, task_id: id }, context.cancelController.signal)
    if (!ownsTask(context, id) || context.cancelEpoch !== epoch) return
    const data = response.data
    if (!response.success || typeof data?.accepted !== 'boolean' || !validPreparationTask(data, context.id, id)) throw new Error('Unconfirmed cancellation')
    // Reads launched while this mutation was pending may describe its earlier
    // preparing state. The confirmed reply supersedes those observations.
    ++context.cancelEpoch
    cancelNeedsObservation.value = false
    if (applyPreparationTask(context, data)) return
    if (!data.accepted && data.preparation_phase === 'finalizing') cancelFeedback.value = 'localPlan.cancelTooLate'
    if (data.preparation_phase === 'ready' || data.status === 'completed') await loadPreparedData(context)
    else if (data.preparation_phase === 'failed' || data.status === 'failed') handlePrepareFailure(null, context)
  } catch {
    if (!ownsTask(context, id) || context.cancelEpoch !== epoch) return
    // The mutation may have succeeded. Only a new owned status read can enable
    // an explicit retry; an already in-flight read cannot resolve uncertainty.
    ++context.cancelEpoch
    cancelNeedsObservation.value = true
    cancelFeedback.value = 'localPlan.cancelUnknown'
  } finally {
    if (ownsView(context) && taskId.value === id) cancelPending.value = false
  }
}

// 自动开始准备模拟
const startPrepareSimulation = (context = preparationContext, payload = null) => singleFlight(context, 'prepare', async () => {
  if (!payload && runtimeMode.value !== 'cloud') return
  let requestTaskId = taskId.value
  // 标记第一步完成，开始第二步
  phase.value = 1
  addLog(t('log.simInstanceCreated', { id: context.id }))
  addLog(t('log.preparingSimEnv'))
  emit('update-status', 'processing')
  
  try {
    const res = await prepareSimulation(payload || {
      simulation_id: context.id,
      use_llm_for_profiles: true,
      parallel_profile_count: 5
    }, context.controller.signal)
    if (!ownsTask(context, requestTaskId)) return
    
    if (res.success && res.data) {
      if (res.data.preparation_task) {
        const projection = res.data.preparation_task
        if (!validPreparationTask(projection, context.id, res.data.task_id)) {
          handlePrepareFailure(null, context)
          return
        }
        taskId.value = res.data.task_id
        requestTaskId = taskId.value
        if (applyPreparationTask(context, projection) && !isActive(context)) return
      }
      if (res.data.already_prepared && !cancellationBlocked.value) {
        addLog(t('log.detectedExistingPrep'))
        await loadPreparedData(context)
        return
      }
      
      taskId.value = res.data.task_id
      requestTaskId = taskId.value
      addLog(t('log.prepareTaskStarted'))
      addLog(t('log.prepareTaskId', { taskId: res.data.task_id }))
      
      // 立即设置预期Agent总数（从prepare接口返回值获取）
      if (res.data.expected_entities_count) {
        expectedTotal.value = res.data.expected_entities_count
        addLog(t('log.zepEntitiesFound', { count: res.data.expected_entities_count }))
        if (res.data.entity_types && res.data.entity_types.length > 0) {
          addLog(t('log.entityTypes', { types: res.data.entity_types.join(', ') }))
        }
      }
      
      addLog(t('log.startPollingProgress'))
      // 开始轮询进度
      startPolling(context)
      // 开始实时获取 Profiles
      startProfilesPolling(context)
    } else {
      addLog(runtimeMode.value === 'local' ? t(planningErrorKey(res)) : t('log.prepareFailed', { error: res.error || t('common.unknownError') }))
      if (runtimeMode.value === 'local') planError.value = planningErrorKey(res)
      finishPreparation(context, 'error')
    }
  } catch (err) {
    if (!ownsTask(context, requestTaskId)) return
    addLog(runtimeMode.value === 'local' ? t(planningErrorKey(err)) : t('log.prepareException', { error: err.message }))
    if (runtimeMode.value === 'local') planError.value = planningErrorKey(err)
    finishPreparation(context, 'error')
  }
})

// A passive mode check is required even for the legacy automatic cloud flow.
const resolvePreparationPlan = context => singleFlight(context, 'plan', async () => {
  const observedAfterCleanup = props.cleanupReady
  context.waitingCleanup = false
  planLoading.value = true
  planError.value = ''
  try {
    const response = await getPreparationPlan(context.id, context.controller.signal)
    if (!isActive(context)) return
    const plan = response.data
    if (!response.success || plan?.simulation_id !== context.id || !['local', 'cloud'].includes(plan.mode)) {
      planError.value = planningErrorKey(response)
      emit('update-status', 'error')
      return
    }
    runtimeMode.value = plan.mode
    emit('runtime-mode', plan.mode)
    if (plan.mode === 'cloud') { startPrepareSimulation(context); return }
    localPlan.value = plan
    if (!observedAfterCleanup || !props.cleanupReady) { context.waitingCleanup = true; return }
    context.waitingCleanup = false
    if (!validLocalPlan(plan)) { planError.value = 'localPlan.invalidLimits'; emit('update-status', 'error'); return }
    if (!validLocalMaximum(localMaxRounds.value, plan.limits.max_rounds)) localMaxRounds.value = plan.limits.max_rounds
    if (plan.cancellation?.blocked === true) {
      cancellationBlocked.value = true
      simulationConfig.value = null
    }
    const projectedTask = plan.preparation_task
    const expectedTaskId = plan.owner?.task_id || plan.cancellation?.task_id
    if (validPreparationTask(projectedTask, context.id, expectedTaskId)) {
      taskId.value = projectedTask.task_id
      phase.value = 1
      const handled = applyPreparationTask(context, projectedTask)
      if (!isActive(context)) return
      if (!handled && projectedTask.preparation_phase === 'ready') { await loadPreparedData(context); return }
      if (!handled && projectedTask.preparation_phase === 'failed') { handlePrepareFailure(null, context); return }
      emit('update-status', projectedTask.preparation_phase === 'unavailable' ? 'blocked' : 'processing')
      startPolling(context)
      startProfilesPolling(context)
      return
    }
    if (projectedTask != null) {
      planError.value = 'localPlan.requestError'
      emit('update-status', 'error')
      return
    }
    if (cancellationBlocked.value) { emit('update-status', 'blocked'); return }
    if (plan.owner.busy && plan.owner.reason_code === 'preparation_busy' && typeof plan.owner.task_id === 'string' && plan.owner.task_id) {
      taskId.value = plan.owner.task_id
      phase.value = 1
      emit('update-status', 'processing')
      startPolling(context)
      startProfilesPolling(context)
    } else emit('update-status', plan.owner.busy ? 'blocked' : 'idle')
  } catch (error) {
    if (isActive(context)) { planError.value = planningErrorKey(error); emit('update-status', 'error') }
  } finally {
    if (ownsView(context)) planLoading.value = false
  }
}).then(() => {
  if (isActive(context) && context.waitingCleanup && props.cleanupReady) return resolvePreparationPlan(context)
})

const loadLocalCast = context => {
  if (!isActive(context) || !canPrepareLocal.value) return Promise.resolve()
  retirePreset()
  catalogSnapshot.value = null
  loadingCast.value = true
  return singleFlight(context, 'preview', async () => {
    try {
      const response = await previewPreparation({ simulation_id: context.id }, context.controller.signal)
      if (!isActive(context)) return
      if (!response.success || !validLocalCatalog(response.data, context.id)) { planError.value = planningErrorKey(response); return }
      localPlan.value = { ...localPlan.value, limits: response.data.limits }
      retirePreset()
      catalogSnapshot.value = { ...response.data, limits: { ...response.data.limits }, entities: response.data.entities.map(entity => ({ ...entity })) }
      catalog.value = catalogSnapshot.value.entities
      catalogLoaded.value = true
      selectedEntityIds.value = []
      typeFilter.value = ''
    } catch (error) {
      if (isActive(context)) planError.value = planningErrorKey(error)
    } finally {
      if (isActive(context)) loadingCast.value = false
    }
  })
}

const prepareLocal = (context, reuse) => {
  if (!isActive(context) || !(reuse ? canReuseLocal.value : canPrepareLocal.value)) return Promise.resolve()
  let payload = { simulation_id: context.id, preparation_mode: 'reuse' }
  if (!reuse) {
    const ids = [...selectedEntityIds.value]
    if (!localRoundsValid.value || !catalogLoaded.value || ids.length < 1 || ids.length > localPlan.value.limits.max_selectable_agents
      || new Set(ids).size !== ids.length || ids.some(id => !catalog.value.some(entity => entity.uuid === id))) return Promise.resolve()
    payload = { simulation_id: context.id, preparation_mode: 'prepare', selected_entity_ids: ids,
      use_llm_for_profiles: useLlmProfiles.value,
      parallel_profile_count: Math.min(3, localPlan.value.limits.max_concurrency, ids.length) }
  }
  actionPending.value = true
  return startPrepareSimulation(context, payload).finally(() => { if (ownsView(context)) actionPending.value = false })
}

const startPolling = (context = preparationContext) => {
  if (!isActive(context) || pollTimer !== null) return
  pollTimer = setInterval(() => pollPrepareStatus(context), 2000)
}

const stopPolling = () => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const startProfilesPolling = (context = preparationContext) => {
  if (!isActive(context) || profilesTimer !== null) return
  profilesTimer = setInterval(() => fetchProfilesRealtime(context), 3000)
}

const stopProfilesPolling = () => {
  if (profilesTimer !== null) {
    clearInterval(profilesTimer)
    profilesTimer = null
  }
}

const pollPrepareStatus = (context = preparationContext) => singleFlight(context, 'status', async () => {
  const observedTaskId = taskId.value, epoch = context.cancelEpoch
  try {
    const res = await getPrepareStatus({
      task_id: observedTaskId,
      simulation_id: context.id
    }, context.controller.signal)
    if (!ownsTask(context, observedTaskId) || context.preparedConfirmed || context.cancelEpoch !== epoch) return
    
    if (res.success && res.data) {
      const data = res.data
      if (runtimeMode.value === 'local' && (preparationTask.value || data.preparation_phase)) {
        if (!validPreparationTask(data, context.id, observedTaskId)) return
        // A new owned observation can settle a lost/hung mutation response.
        // A still-preparing read cannot reopen the button during that request.
        if (cancelPending.value) {
          if (data.preparation_phase === 'preparing' && !data.cancellation_requested && !['completed', 'failed', 'cancelled'].includes(data.status)) return
          ++context.cancelEpoch
          context.cancelController.abort()
          cancelPending.value = false
        }
        if (cancelNeedsObservation.value) {
          cancelNeedsObservation.value = false
          cancelRetry.value = data.can_cancel && data.preparation_phase === 'preparing' && !data.cancellation_requested
          cancelFeedback.value = cancelRetry.value ? 'localPlan.cancelRetryAvailable' : ''
        }
        if (applyPreparationTask(context, data)) return
      }
      
      // 更新进度
      prepareProgress.value = data.progress || 0
      progressMessage.value = runtimeMode.value === 'local' ? '' : data.message || ''
      
      // 解析阶段信息并输出详细日志
      if (runtimeMode.value === 'local') {
        const stage = data.progress_detail?.current_stage_name
        if (['generating_profiles', 'generating_config', 'copying_scripts', '生成Agent人设', '生成模拟配置', '准备模拟脚本'].includes(stage)) currentStage.value = stage
      } else if (data.progress_detail) {
        currentStage.value = data.progress_detail.current_stage_name || ''
        
        // 输出详细进度日志（避免重复）
        const detail = data.progress_detail
        const logKey = `${detail.current_stage}-${detail.current_item}-${detail.total_items}`
        if (logKey !== lastLoggedMessage && detail.item_description) {
          lastLoggedMessage = logKey
          const stageInfo = `[${detail.stage_index}/${detail.total_stages}]`
          if (detail.total_items > 0) {
            addLog(`${stageInfo} ${detail.current_stage_name}: ${detail.current_item}/${detail.total_items} - ${detail.item_description}`)
          } else {
            addLog(`${stageInfo} ${detail.current_stage_name}: ${detail.item_description}`)
          }
        }
      } else if (data.message) {
        // 从消息中提取阶段
        const match = data.message.match(/\[(\d+)\/(\d+)\]\s*([^:]+)/)
        if (match) {
          currentStage.value = match[3].trim()
        }
        // 输出消息日志（避免重复）
        if (data.message !== lastLoggedMessage) {
          lastLoggedMessage = data.message
          addLog(data.message)
        }
      }
      
      // 检查是否完成
      if (data.preparation_phase === 'cancelled' || data.status === 'cancelled') return
      if (data.status === 'completed' || data.status === 'ready' || data.already_prepared || data.preparation_phase === 'ready') {
        addLog(t('log.prepareComplete'))
        stopPolling()
        stopProfilesPolling()
        await loadPreparedData(context)
      } else if (data.status === 'failed') {
        handlePrepareFailure(data.error, context)
      }
    }
  } catch (err) {
    if (!ownsTask(context, observedTaskId) || context.preparedConfirmed || context.cancelEpoch !== epoch) return
    console.warn('轮询状态失败:', err)
  }
})

const fetchProfilesRealtime = (context = preparationContext, final = false) => singleFlight(context, 'profiles', async () => {
  const observedTaskId = taskId.value
  try {
    const res = await getSimulationProfilesRealtime(context.id, undefined, context.controller.signal)
    if (!ownsTask(context, observedTaskId) || (!final && context.preparedConfirmed)) return
    
    if (res.success && res.data) {
      const prevCount = profiles.value.length
      profiles.value = res.data.profiles || []
      // 只有当 API 返回有效值时才更新，避免覆盖已有的有效值
      if (res.data.total_expected) {
        expectedTotal.value = res.data.total_expected
      }
      
      // 提取实体类型
      const types = new Set()
      profiles.value.forEach(p => {
        if (p.entity_type) types.add(p.entity_type)
      })
      entityTypes.value = Array.from(types)
      
      // 输出 Profile 生成进度日志（仅当数量变化时）
      const currentCount = profiles.value.length
      if (currentCount > 0 && currentCount !== lastLoggedProfileCount) {
        lastLoggedProfileCount = currentCount
        const total = expectedTotal.value || '?'
        const latestProfile = profiles.value[currentCount - 1]
        const profileName = latestProfile?.name || latestProfile?.username || `Agent_${currentCount}`
        if (currentCount === 1) {
          addLog(t('log.startGeneratingAgentProfiles'))
        }
        addLog(t('log.agentProfile', { current: currentCount, total: total, name: profileName, profession: latestProfile?.profession || t('step2.unknownProfession') }))

        // 如果全部生成完成
        if (expectedTotal.value && currentCount >= expectedTotal.value) {
          addLog(t('log.allProfilesComplete', { count: currentCount }))
        }
      }
    }
  } catch (err) {
    if (!ownsTask(context, observedTaskId) || (!final && context.preparedConfirmed)) return
    console.warn('获取 Profiles 失败:', err)
  }
})

// 配置轮询
const startConfigPolling = (context = preparationContext) => {
  if (!isActive(context) || cancellationBlocked.value || configTimer !== null) return
  configTimer = setInterval(() => {
    if (context.preparedConfirmed) loadPreparedData(context)
    else fetchConfigRealtime(context)
  }, 2000)
}

const stopConfigPolling = () => {
  if (configTimer !== null) {
    clearInterval(configTimer)
    configTimer = null
  }
}

const fetchConfigRealtime = (context = preparationContext, final = false) => singleFlight(context, 'config', async () => {
  const observedTaskId = taskId.value
  if (cancellationBlocked.value) return
  try {
    const res = await getSimulationConfigRealtime(context.id, context.controller.signal)
    if (!ownsTask(context, observedTaskId) || cancellationBlocked.value || (!final && context.preparedConfirmed)) return
    
    if (res.success && res.data) {
      const data = res.data

      if (data.status === 'failed' || data.error) {
        // Planned tasks own completion and cleanup. A partial config snapshot
        // cannot declare failure before that task publishes its final outcome.
        if (preparationTask.value && !final) return
        handlePrepareFailure(data.error, context)
        return
      }
      
      if (final) return data

      // 输出配置生成阶段日志（避免重复）
      if (data.generation_stage && data.generation_stage !== lastLoggedConfigStage) {
        lastLoggedConfigStage = data.generation_stage
        if (data.generation_stage === 'generating_profiles') {
          addLog(t('log.generatingAgentProfileConfig'))
        } else if (data.generation_stage === 'generating_config') {
          addLog(t('log.generatingLLMConfig'))
        }
      }
      
      // 如果配置已生成
      if (data.config_generated && data.config) {
        simulationConfig.value = data.config
        addLog(t('log.configComplete'))

        // 显示详细配置摘要
        if (data.summary) {
          addLog(t('log.configSummaryAgents', { count: data.summary.total_agents }))
          addLog(t('log.configSummaryHours', { hours: data.summary.simulation_hours }))
          addLog(t('log.configSummaryPosts', { count: data.summary.initial_posts_count }))
          addLog(t('log.configSummaryTopics', { count: data.summary.hot_topics_count }))
          addLog(t('log.configSummaryPlatforms', { twitter: data.summary.has_twitter_config ? '✓' : '✗', reddit: data.summary.has_reddit_config ? '✓' : '✗' }))
        }
        
        // 显示时间配置详情
        if (data.config.time_config) {
          const tc = data.config.time_config
          addLog(t('log.timeConfigDetail', { minutes: tc.minutes_per_round, rounds: Math.floor((tc.total_simulation_hours * 60) / tc.minutes_per_round) }))
        }
        
        // 显示事件配置
        if (data.config.event_config?.narrative_direction) {
          const narrative = data.config.event_config.narrative_direction
          addLog(t('log.narrativeDirection', { direction: narrative.length > 50 ? narrative.substring(0, 50) + '...' : narrative }))
        }
        
        // Config is a preview until preparation confirms scripts are ready.
      }
    }
  } catch (err) {
    if (!ownsTask(context, observedTaskId) || cancellationBlocked.value || (!final && context.preparedConfirmed)) return
    if (final) {
      handlePrepareFailure(t('log.loadConfigFailed', { error: err.message }), context)
      return
    }
    console.warn('获取 Config 失败:', err)
  }
})

const loadPreparedData = (context = preparationContext) => {
  if (!isActive(context) || cancellationBlocked.value) return Promise.resolve()
  const observedTaskId = taskId.value
  // Retire preview replies synchronously at the authoritative ready handoff.
  context.preparedConfirmed = true
  stopAllPolling()
  return singleFlight(context, 'final', async () => {
    phase.value = 2
    addLog(t('log.loadingExistingConfig'))

    // 最后获取一次 Profiles
    if (context.requests.profiles) await context.requests.profiles
    if (!ownsTask(context, observedTaskId) || cancellationBlocked.value) return
    await fetchProfilesRealtime(context, true)
    if (!ownsTask(context, observedTaskId) || cancellationBlocked.value) return
    addLog(t('log.loadedAgentProfiles', { count: profiles.value.length }))

    // 获取配置（使用实时接口）
    try {
      if (context.requests.config) await context.requests.config
      if (!ownsTask(context, observedTaskId) || cancellationBlocked.value) return
      const configState = await fetchConfigRealtime(context, true)
      if (!ownsTask(context, observedTaskId) || cancellationBlocked.value) return
      if (configState) {

        if (configState.status === 'failed' || configState.error) {
          handlePrepareFailure(configState.error, context)
          return
        }

        if (configState.config_generated && configState.config && !configState.is_generating && configState.status !== 'preparing') {
          simulationConfig.value = configState.config
          addLog(t('log.configLoadSuccess'))

          // 显示详细配置摘要
          if (configState.summary) {
            addLog(t('log.configSummaryAgents', { count: configState.summary.total_agents }))
            addLog(t('log.configSummaryHours', { hours: configState.summary.simulation_hours }))
            addLog(t('log.configSummaryPostsAlt', { count: configState.summary.initial_posts_count }))
          }

          addLog(t('log.envSetupComplete'))
          phase.value = 4
          finishPreparation(context, 'completed')
        } else if (configState.is_generating) {
          addLog(t('log.configGenerating'))
          startConfigPolling(context)
        } else {
          handlePrepareFailure(t('log.configNotGenerating'), context)
        }
      }
    } catch (err) {
      if (!ownsTask(context, observedTaskId) || cancellationBlocked.value) return
      handlePrepareFailure(t('log.loadConfigFailed', { error: err.message }), context)
    }
  })
}

// Scroll log to bottom
const logContent = ref(null)
watch(() => props.systemLogs?.length, () => {
  nextTick(() => {
    if (logContent.value) {
      logContent.value.scrollTop = logContent.value.scrollHeight
    }
  })
})

watch(() => props.cleanupReady, ready => {
  const context = preparationContext
  if (ready && isActive(context) && context.waitingCleanup) {
    const pending = context.requests.plan || Promise.resolve()
    pending.then(() => { if (isActive(context) && context.waitingCleanup) resolvePreparationPlan(context) })
  }
}, { flush: 'sync' })

watch(() => props.simulationId, () => {
  if (mounted) replacePreparation()
}, { flush: 'sync' })

onMounted(() => {
  mounted = true
  replacePreparation()
})

onUnmounted(() => {
  mounted = false
  if (preparationContext) { preparationContext.controller.abort(); preparationContext.cancelController.abort() }
  retirePreset()
  preparationContext = null
  stopAllPolling()
})

</script>

<style scoped>
.local-rounds input { width: 100px; margin-left: 12px; padding: 8px; border: 1px solid #aaa; border-radius: 4px; }
.local-rounds p { font-size: 13px; line-height: 1.6; color: #555; }
.env-setup-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #FAFAFA;
  font-family: 'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif;
}

.scroll-container {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Step Card */
.step-card {
  background: #FFF;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  border: 1px solid #EAEAEA;
  transition: all 0.3s ease;
  position: relative;
}

.step-card.active {
  border-color: #FF5722;
  box-shadow: 0 4px 12px rgba(255, 87, 34, 0.08);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.step-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 20px;
  font-weight: 700;
  color: #E0E0E0;
}

.step-card.active .step-num,
.step-card.completed .step-num {
  color: #000;
}

.step-title {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.5px;
}

.badge {
  font-size: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.success { background: #E8F5E9; color: #2E7D32; }
.badge.processing { background: #FF5722; color: #FFF; }
.badge.pending { background: #F5F5F5; color: #999; }
.badge.accent { background: #E3F2FD; color: #1565C0; }

.card-content {
  /* No extra padding - uses step-card's padding */
}

.api-note {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #999;
  margin-bottom: 8px;
}

.description {
  font-size: 12px;
  color: #666;
  line-height: 1.5;
  margin-bottom: 16px;
}

/* Action Section */
.action-section {
  margin-top: 16px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn.primary {
  background: #000;
  color: #FFF;
}

.action-btn.primary:hover:not(:disabled) {
  opacity: 0.8;
}

.action-btn.secondary {
  background: #F5F5F5;
  color: #333;
}

.action-btn.secondary:hover:not(:disabled) {
  background: #E5E5E5;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-group {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.action-group.dual {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.action-group.dual .action-btn {
  width: 100%;
}

/* Info Card */
.info-card {
  background: #F5F5F5;
  border-radius: 6px;
  padding: 16px;
  margin-top: 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px dashed #E0E0E0;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  font-size: 12px;
  color: #666;
}

.info-value {
  font-size: 13px;
  font-weight: 500;
}

.info-value.mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

/* Stats Grid */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  background: #F9F9F9;
  padding: 16px;
  border-radius: 6px;
}

.stat-card {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 20px;
  font-weight: 700;
  color: #000;
  font-family: 'JetBrains Mono', monospace;
}

.stat-label {
  font-size: 9px;
  color: #999;
  text-transform: uppercase;
  margin-top: 4px;
  display: block;
}

/* Profiles Preview */
.profiles-preview {
  margin-top: 20px;
  border-top: 1px solid #E5E5E5;
  padding-top: 16px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.preview-title {
  font-size: 12px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.profiles-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 4px;
}

.profiles-list::-webkit-scrollbar {
  width: 4px;
}

.profiles-list::-webkit-scrollbar-thumb {
  background: #DDD;
  border-radius: 2px;
}

.profiles-list::-webkit-scrollbar-thumb:hover {
  background: #CCC;
}

.profile-card {
  background: #FAFAFA;
  border: 1px solid #E5E5E5;
  border-radius: 6px;
  padding: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.profile-card:hover {
  border-color: #999;
  background: #FFF;
}

.profile-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.profile-realname {
  font-size: 14px;
  font-weight: 700;
  color: #000;
}

.profile-username {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #999;
}

.profile-meta {
  margin-bottom: 8px;
}

.profile-profession {
  font-size: 11px;
  color: #666;
  background: #F0F0F0;
  padding: 2px 8px;
  border-radius: 3px;
}

.profile-bio {
  font-size: 12px;
  color: #444;
  line-height: 1.6;
  margin: 0 0 10px 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.profile-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.topic-tag {
  font-size: 10px;
  color: #1565C0;
  background: #E3F2FD;
  padding: 2px 8px;
  border-radius: 10px;
}

.topic-more {
  font-size: 10px;
  color: #999;
  padding: 2px 6px;
}

/* Config Preview */
/* Config Detail Panel */
.config-detail-panel {
  margin-top: 16px;
}

.config-block {
  margin-top: 16px;
  border-top: 1px solid #E5E5E5;
  padding-top: 12px;
}

.config-block:first-child {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}

.config-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.config-block-title {
  font-size: 12px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.config-block-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  background: #F1F5F9;
  color: #475569;
  padding: 2px 8px;
  border-radius: 10px;
}

/* Config Grid */
.config-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.config-item {
  background: #F9F9F9;
  padding: 12px 14px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-item-label {
  font-size: 11px;
  color: #94A3B8;
}

.config-item-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  font-weight: 600;
  color: #1E293B;
}

/* Time Periods */
.time-periods {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.period-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #F9F9F9;
  border-radius: 6px;
}

.period-label {
  font-size: 12px;
  font-weight: 500;
  color: #64748B;
  min-width: 70px;
}

.period-hours {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #475569;
  flex: 1;
}

.period-multiplier {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  color: #6366F1;
  background: #EEF2FF;
  padding: 2px 6px;
  border-radius: 4px;
}

/* Agents Cards */
.agents-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 4px;
}

.agents-cards::-webkit-scrollbar {
  width: 4px;
}

.agents-cards::-webkit-scrollbar-thumb {
  background: #DDD;
  border-radius: 2px;
}

.agents-cards::-webkit-scrollbar-thumb:hover {
  background: #CCC;
}

.agent-card {
  background: #F9F9F9;
  border: 1px solid #E5E5E5;
  border-radius: 6px;
  padding: 14px;
  transition: all 0.2s ease;
}

.agent-card:hover {
  border-color: #999;
  background: #FFF;
}

/* Agent Card Header */
.agent-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #F1F5F9;
}

.agent-identity {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-id {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #94A3B8;
}

.agent-name {
  font-size: 14px;
  font-weight: 600;
  color: #1E293B;
}

.agent-tags {
  display: flex;
  gap: 6px;
}

.agent-type {
  font-size: 10px;
  color: #64748B;
  background: #F1F5F9;
  padding: 2px 8px;
  border-radius: 4px;
}

.agent-stance {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 4px;
}

.stance-neutral {
  background: #F1F5F9;
  color: #64748B;
}

.stance-supportive {
  background: #DCFCE7;
  color: #16A34A;
}

.stance-opposing {
  background: #FEE2E2;
  color: #DC2626;
}

.stance-observer {
  background: #FEF3C7;
  color: #D97706;
}

/* Agent Timeline */
.agent-timeline {
  margin-bottom: 14px;
}

.timeline-label {
  display: block;
  font-size: 10px;
  color: #94A3B8;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.mini-timeline {
  display: flex;
  gap: 2px;
  height: 16px;
  background: #F8FAFC;
  border-radius: 4px;
  padding: 3px;
}

.timeline-hour {
  flex: 1;
  background: #E2E8F0;
  border-radius: 2px;
  transition: all 0.2s;
}

.timeline-hour.active {
  background: linear-gradient(180deg, #6366F1, #818CF8);
}

.timeline-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: #94A3B8;
}

/* Agent Params */
.agent-params {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.param-group {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.param-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.param-item .param-label {
  font-size: 10px;
  color: #94A3B8;
}

.param-item .param-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.param-value.with-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-bar {
  height: 4px;
  background: linear-gradient(90deg, #6366F1, #A855F7);
  border-radius: 2px;
  min-width: 4px;
  max-width: 40px;
}

.param-value.positive {
  color: #16A34A;
}

.param-value.negative {
  color: #DC2626;
}

.param-value.neutral {
  color: #64748B;
}

.param-value.highlight {
  color: #6366F1;
}

/* Platforms Grid */
.platforms-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.platform-card {
  background: #F9F9F9;
  padding: 14px;
  border-radius: 6px;
}

.platform-card-header {
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #E5E5E5;
}

.platform-name {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.platform-params {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.param-label {
  font-size: 12px;
  color: #64748B;
}

.param-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: #1E293B;
}

/* Reasoning Content */
.reasoning-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reasoning-item {
  padding: 12px 14px;
  background: #F9F9F9;
  border-radius: 6px;
}

.reasoning-text {
  font-size: 13px;
  color: #555;
  line-height: 1.7;
  margin: 0;
}

/* Profile Modal */
.profile-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.profile-modal {
  background: #FFF;
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: 85vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 24px;
  background: #FFF;
  border-bottom: 1px solid #F0F0F0;
}

.modal-header-info {
  flex: 1;
}

.modal-name-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.modal-realname {
  font-size: 20px;
  font-weight: 700;
  color: #000;
}

.modal-username {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: #999;
}

.modal-profession {
  font-size: 12px;
  color: #666;
  background: #F5F5F5;
  padding: 4px 10px;
  border-radius: 4px;
  display: inline-block;
  font-weight: 500;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  color: #999;
  border-radius: 50%;
  font-size: 24px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: color 0.2s;
  padding: 0;
}

.close-btn:hover {
  color: #333;
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}

/* 基本信息网格 */
.modal-info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px 16px;
  margin-bottom: 32px;
  padding: 0;
  background: transparent;
  border-radius: 0;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 11px;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.info-value {
  font-size: 15px;
  font-weight: 600;
  color: #333;
}

.info-value.mbti {
  font-family: 'JetBrains Mono', monospace;
  color: #FF5722;
}

/* 模块区域 */
.modal-section {
  margin-bottom: 28px;
}

.section-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.section-bio {
  font-size: 14px;
  color: #333;
  line-height: 1.6;
  margin: 0;
  padding: 16px;
  background: #F9F9F9;
  border-radius: 6px;
  border-left: 3px solid #E0E0E0;
}

/* 话题标签 */
.topics-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.topic-item {
  font-size: 11px;
  color: #1565C0;
  background: #E3F2FD;
  padding: 4px 10px;
  border-radius: 12px;
  transition: all 0.2s;
  border: none;
}

.topic-item:hover {
  background: #BBDEFB;
  color: #0D47A1;
}

/* 详细人设 */
.persona-dimensions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.dimension-card {
  background: #F8F9FA;
  padding: 12px;
  border-radius: 6px;
  border-left: 3px solid #DDD;
  transition: all 0.2s;
}

.dimension-card:hover {
  background: #F0F0F0;
  border-left-color: #999;
}

.dim-title {
  display: block;
  font-size: 12px;
  font-weight: 700;
  color: #333;
  margin-bottom: 4px;
}

.dim-desc {
  display: block;
  font-size: 10px;
  color: #888;
  line-height: 1.4;
}

.persona-content {
  max-height: none;
  overflow: visible;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
}

.persona-content::-webkit-scrollbar {
  width: 4px;
}

.persona-content::-webkit-scrollbar-thumb {
  background: #DDD;
  border-radius: 2px;
}

.section-persona {
  font-size: 13px;
  color: #555;
  line-height: 1.8;
  margin: 0;
  text-align: justify;
}

/* System Logs */
.system-logs {
  background: #000;
  color: #DDD;
  padding: 16px;
  font-family: 'JetBrains Mono', monospace;
  border-top: 1px solid #222;
  flex-shrink: 0;
}

.log-header {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid #333;
  padding-bottom: 8px;
  margin-bottom: 8px;
  font-size: 10px;
  color: #888;
}

.log-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 80px; /* Approx 4 lines visible */
  overflow-y: auto;
  padding-right: 4px;
}

.log-content::-webkit-scrollbar {
  width: 4px;
}

.log-content::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 2px;
}

.log-line {
  font-size: 11px;
  display: flex;
  gap: 12px;
  line-height: 1.5;
}

.log-time {
  color: #666;
  min-width: 75px;
}

.log-msg {
  color: #CCC;
  word-break: break-all;
}

/* Spinner */
.spinner-sm {
  width: 16px;
  height: 16px;
  border: 2px solid #E5E5E5;
  border-top-color: #FF5722;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
/* Orchestration Content */
.orchestration-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-top: 16px;
}

.box-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.narrative-box {
  background: #FFFFFF;
  padding: 20px 24px;
  border-radius: 12px;
  border: 1px solid #EEF2F6;
  box-shadow: 0 4px 24px rgba(0,0,0,0.03);
  transition: all 0.3s ease;
}

.narrative-box .box-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #666;
  font-size: 13px;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
  font-weight: 600;
}

.special-icon {
  filter: drop-shadow(0 2px 4px rgba(255, 87, 34, 0.2));
  transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.narrative-box:hover .special-icon {
  transform: rotate(180deg);
}

.narrative-text {
  font-family: 'Inter', 'Noto Sans SC', system-ui, sans-serif;
  font-size: 14px;
  color: #334155;
  line-height: 1.8;
  margin: 0;
  text-align: justify;
  letter-spacing: 0.01em;
}

.topics-section {
  background: #FFF;
}

.hot-topics-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hot-topic-tag {
  font-size: 12px;
  color:rgba(255, 86, 34, 0.88);
  background: #FFF3E0;
  padding: 4px 10px;
  border-radius: 12px;
  font-weight: 500;
}

.hot-topic-more {
  font-size: 11px;
  color: #999;
  padding: 4px 6px;
}

.initial-posts-section {
  border-top: 1px solid #EAEAEA;
  padding-top: 16px;
}

.posts-timeline {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-left: 8px;
  border-left: 2px solid #F0F0F0;
  margin-top: 12px;
}

.timeline-item {
  position: relative;
  padding-left: 20px;
}

.timeline-marker {
  position: absolute;
  left: 0;
  top: 14px;
  width: 12px;
  height: 2px;
  background: #DDD;
}

.timeline-content {
  background: #F9F9F9;
  padding: 12px;
  border-radius: 6px;
  border: 1px solid #EEE;
}

.post-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.post-role {
  font-size: 11px;
  font-weight: 700;
  color: #333;
  text-transform: uppercase;
}

.post-agent-info {
  display: flex;
  align-items: center;
  gap: 6px;
}

.post-id,
.post-username {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #666;
  line-height: 1;
  vertical-align: baseline;
}

.post-username {
  margin-right: 6px;
}

.post-text {
  font-size: 12px;
  color: #555;
  line-height: 1.5;
  margin: 0;
}

/* 模拟轮数配置样式 */
.rounds-config-section {
  margin: 24px 0;
  padding-top: 24px;
  border-top: 1px solid #EAEAEA;
}

.rounds-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #1E293B;
}

.section-desc {
  font-size: 12px;
  color: #94A3B8;
}

.desc-highlight {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: #1E293B;
  background: #F1F5F9;
  padding: 1px 6px;
  border-radius: 4px;
  margin: 0 2px;
}

/* Switch Control */
.switch-control {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px 4px 4px;
  border-radius: 20px;
  transition: background 0.2s;
}

.switch-control:hover {
  background: #F8FAFC;
}

.switch-control input {
  display: none;
}

.switch-track {
  width: 36px;
  height: 20px;
  background: #E2E8F0;
  border-radius: 10px;
  position: relative;
  transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
}

.switch-track::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 16px;
  height: 16px;
  background: #FFF;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  transition: transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
}

.switch-control input:checked + .switch-track {
  background: #000;
}

.switch-control input:checked + .switch-track::after {
  transform: translateX(16px);
}

.switch-label {
  font-size: 12px;
  font-weight: 500;
  color: #64748B;
}

.switch-control input:checked ~ .switch-label {
  color: #1E293B;
}

/* Slider Content */
.rounds-content {
  animation: fadeIn 0.3s ease;
}

.slider-display {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 16px;
}

.slider-main-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.val-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 24px;
  font-weight: 700;
  color: #000;
}

.val-unit {
  font-size: 12px;
  color: #666;
  font-weight: 500;
}

.slider-meta-info {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #64748B;
  background: #F1F5F9;
  padding: 4px 8px;
  border-radius: 4px;
}

.range-wrapper {
  position: relative;
  padding: 0 2px;
}

.minimal-slider {
  -webkit-appearance: none;
  width: 100%;
  height: 4px;
  background: #E2E8F0;
  border-radius: 2px;
  outline: none;
  background-image: linear-gradient(#000, #000);
  background-size: var(--percent, 0%) 100%;
  background-repeat: no-repeat;
  cursor: pointer;
}

.minimal-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #FFF;
  border: 2px solid #000;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
  transition: transform 0.1s;
  margin-top: -6px; /* Center thumb */
}

.minimal-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}

.minimal-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
}

.range-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #94A3B8;
  position: relative;
}

.mark-recommend {
  cursor: pointer;
  transition: color 0.2s;
  position: relative;
}

.mark-recommend:hover {
  color: #000;
}

.mark-recommend.active {
  color: #000;
  font-weight: 600;
}

.mark-recommend::after {
  content: '';
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  width: 1px;
  height: 4px;
  background: #CBD5E1;
}

/* Auto Info */
.auto-info-card {
  display: flex;
  align-items: center;
  gap: 24px;
  background: #F8FAFC;
  padding: 16px 20px;
  border-radius: 8px;
}

.auto-value {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 4px;
  padding-right: 24px;
  border-right: 1px solid #E2E8F0;
}

.auto-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
}

.auto-meta-row {
  display: flex;
  align-items: center;
}

.duration-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  color: #64748B;
  background: #FFFFFF;
  border: 1px solid #E2E8F0;
  padding: 3px 8px;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.02);
}

.auto-desc {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auto-desc p {
  margin: 0;
  font-size: 13px;
  color: #64748B;
  line-height: 1.5;
}

.highlight-tip {
  margin-top: 4px !important;
  font-size: 12px !important;
  color: #000 !important;
  font-weight: 500;
  cursor: pointer;
}

.highlight-tip:hover {
  text-decoration: underline;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .profile-modal {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.modal-leave-active .profile-modal {
  transition: all 0.3s ease-in;
}

.modal-enter-from .profile-modal,
.modal-leave-to .profile-modal {
  transform: scale(0.95) translateY(10px);
  opacity: 0;
}
</style>
