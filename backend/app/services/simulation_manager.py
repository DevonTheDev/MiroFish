"""
OASIS模拟管理器
管理Twitter和Reddit双平台并行模拟
使用预设脚本 + LLM智能生成配置参数
"""

import os
import json
import shutil
from typing import Callable, Dict, Any, List, Optional
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from ..config import Config
from ..storage import StoragePathError, storage_path, validate_record_id
from ..utils.logger import get_logger
from ..utils.persistence import write_json_atomic
from ..utils.preparation_cancellation import PreparationCancelled
from .zep_entity_reader import ZepEntityReader, FilteredEntities
from .oasis_profile_generator import OasisProfileGenerator, OasisAgentProfile
from .simulation_config_generator import SimulationConfigGenerator, SimulationParameters
from .platform_selection import validate_platform_flags
from .profile_formats import normalize_twitter_profile
from ..utils.locale import t

logger = get_logger('mirofish.simulation')


class SimulationStatus(str, Enum):
    """模拟状态"""
    CREATED = "created"
    PREPARING = "preparing"
    READY = "ready"
    RUNNING = "running"
    STOPPING = "stopping"
    PAUSED = "paused"
    STOPPED = "stopped"      # 模拟被手动停止
    COMPLETED = "completed"  # 模拟自然完成
    FAILED = "failed"


class PlatformType(str, Enum):
    """平台类型"""
    TWITTER = "twitter"
    REDDIT = "reddit"


@dataclass
class SimulationState:
    """模拟状态"""
    simulation_id: str
    project_id: str
    graph_id: str
    
    # 平台启用状态
    enable_twitter: bool = True
    enable_reddit: bool = True
    
    # 状态
    status: SimulationStatus = SimulationStatus.CREATED
    
    # 准备阶段数据
    entities_count: int = 0
    profiles_count: int = 0
    entity_types: List[str] = field(default_factory=list)
    
    # 配置生成信息
    profiles_generated: bool = False
    config_generated: bool = False
    config_reasoning: str = ""
    
    # 运行时数据
    current_round: int = 0
    twitter_status: str = "not_started"
    reddit_status: str = "not_started"
    
    # 时间戳
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    # 错误信息
    error: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """完整状态字典（内部使用）"""
        return {
            "simulation_id": self.simulation_id,
            "project_id": self.project_id,
            "graph_id": self.graph_id,
            "enable_twitter": self.enable_twitter,
            "enable_reddit": self.enable_reddit,
            "status": self.status.value,
            "entities_count": self.entities_count,
            "profiles_count": self.profiles_count,
            "entity_types": self.entity_types,
            "profiles_generated": self.profiles_generated,
            "config_generated": self.config_generated,
            "config_reasoning": self.config_reasoning,
            "current_round": self.current_round,
            "twitter_status": self.twitter_status,
            "reddit_status": self.reddit_status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error": self.error,
        }
    
    def get_default_platform(self) -> str:
        """根据启用状态返回默认平台"""
        if self.enable_twitter and self.enable_reddit:
            return "reddit"  # 两者都启用时保持原默认
        elif self.enable_twitter:
            return "twitter"
        else:
            return "reddit"

    def to_simple_dict(self) -> Dict[str, Any]:
        """简化状态字典（API返回使用）"""
        return {
            "simulation_id": self.simulation_id,
            "project_id": self.project_id,
            "graph_id": self.graph_id,
            "status": self.status.value,
            "entities_count": self.entities_count,
            "profiles_count": self.profiles_count,
            "entity_types": self.entity_types,
            "profiles_generated": self.profiles_generated,
            "config_generated": self.config_generated,
            "error": self.error,
        }


class SimulationManager:
    """
    模拟管理器
    
    核心功能：
    1. 从Zep图谱读取实体并过滤
    2. 生成OASIS Agent Profile
    3. 使用LLM智能生成模拟配置参数
    4. 准备预设脚本所需的所有文件
    """
    
    # 模拟数据存储目录
    SIMULATION_DATA_DIR = os.path.join(
        os.path.dirname(__file__), 
        '../../uploads/simulations'
    )
    
    def __init__(self):
        # 确保目录存在
        os.makedirs(self.SIMULATION_DATA_DIR, exist_ok=True)
        
        # 内存中的模拟状态缓存
        self._simulations: Dict[str, SimulationState] = {}
    
    def _get_simulation_dir(self, simulation_id: str) -> str:
        """Return a validated directory without creating a record on reads."""
        return self._get_simulation_path(simulation_id)

    def _get_simulation_path(self, simulation_id: str, *components: str) -> str:
        return storage_path(self.SIMULATION_DATA_DIR, validate_record_id(simulation_id), *components)
    
    def _save_simulation_state(self, state: SimulationState):
        """保存模拟状态到文件"""
        sim_dir = self._get_simulation_dir(state.simulation_id)
        state_file = self._get_simulation_path(state.simulation_id, "state.json")
        os.makedirs(sim_dir, exist_ok=True)

        state.updated_at = datetime.now().isoformat()
        
        write_json_atomic(state_file, state.to_dict(), logger=logger)
        
        self._simulations[state.simulation_id] = state
    
    def _load_simulation_state(self, simulation_id: str) -> Optional[SimulationState]:
        """从文件加载模拟状态"""
        # Validate before a cache hit so aliases cannot bypass the file boundary.
        state_file = self._get_simulation_path(simulation_id, "state.json")
        if simulation_id in self._simulations:
            return self._simulations[simulation_id]
        
        if not os.path.exists(state_file):
            return None
        
        with open(state_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if type(data) is not dict or data.get("simulation_id", simulation_id) != simulation_id:
            raise ValueError("Invalid saved simulation metadata")
        
        state = SimulationState(
            simulation_id=simulation_id,
            project_id=data.get("project_id", ""),
            graph_id=data.get("graph_id", ""),
            enable_twitter=data.get("enable_twitter", True),
            enable_reddit=data.get("enable_reddit", True),
            status=SimulationStatus(data.get("status", "created")),
            entities_count=data.get("entities_count", 0),
            profiles_count=data.get("profiles_count", 0),
            entity_types=data.get("entity_types", []),
            profiles_generated=data.get("profiles_generated", False),
            config_generated=data.get("config_generated", False),
            config_reasoning=data.get("config_reasoning", ""),
            current_round=data.get("current_round", 0),
            twitter_status=data.get("twitter_status", "not_started"),
            reddit_status=data.get("reddit_status", "not_started"),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
            error=data.get("error"),
        )
        
        self._simulations[simulation_id] = state
        return state
    
    def create_simulation(
        self,
        project_id: str,
        graph_id: str,
        enable_twitter: bool = True,
        enable_reddit: bool = True,
    ) -> SimulationState:
        """
        创建新的模拟
        
        Args:
            project_id: 项目ID
            graph_id: Zep图谱ID
            enable_twitter: 是否启用Twitter模拟
            enable_reddit: 是否启用Reddit模拟
            
        Returns:
            SimulationState
        """
        validate_platform_flags(enable_twitter, enable_reddit)
        import uuid
        simulation_id = f"sim_{uuid.uuid4().hex[:12]}"
        
        state = SimulationState(
            simulation_id=simulation_id,
            project_id=project_id,
            graph_id=graph_id,
            enable_twitter=enable_twitter,
            enable_reddit=enable_reddit,
            status=SimulationStatus.CREATED,
        )
        
        self._save_simulation_state(state)
        logger.info(f"创建模拟: {simulation_id}, project={project_id}, graph={graph_id}")
        
        return state
    
    def prepare_simulation(
        self,
        simulation_id: str,
        simulation_requirement: str,
        document_text: str,
        defined_entity_types: Optional[List[str]] = None,
        use_llm_for_profiles: bool = True,
        progress_callback: Optional[callable] = None,
        parallel_profile_count: int = 3,
        *,
        selected_entity_ids: Optional[List[str]] = None,
        max_graph_nodes: Optional[int] = None,
        max_graph_edges: Optional[int] = None,
        cancellation_check: Optional[Callable[[], None]] = None,
        begin_finalization: Optional[Callable[[], None]] = None,
    ) -> SimulationState:
        """
        准备模拟环境（全程自动化）
        
        步骤：
        1. 从Zep图谱读取并过滤实体
        2. 为每个实体生成OASIS Agent Profile（可选LLM增强，支持并行）
        3. 使用LLM智能生成模拟配置参数（时间、活跃度、发言频率等）
        4. 保存配置文件和Profile文件
        5. 复制预设脚本到模拟目录
        
        Args:
            simulation_id: 模拟ID
            simulation_requirement: 模拟需求描述（用于LLM生成配置）
            document_text: 原始文档内容（用于LLM理解背景）
            defined_entity_types: 预定义的实体类型（可选）
            use_llm_for_profiles: 是否使用LLM生成详细人设
            progress_callback: 进度回调函数 (stage, progress, message)
            parallel_profile_count: 并行生成人设的数量，默认3
            cancellation_check: 可选的协作取消检查
            begin_finalization: 写入最终配置前原子关闭取消入口
            
        Returns:
            SimulationState
        """
        state = self._load_simulation_state(simulation_id)
        if not state:
            raise ValueError(f"模拟不存在: {simulation_id}")

        # Fail before changing saved state or starting graph/model work.
        self._get_simulation_path(simulation_id, "simulation_config.json")
        if state.enable_reddit:
            self._get_simulation_path(simulation_id, "reddit_profiles.json")
        if state.enable_twitter:
            self._get_simulation_path(simulation_id, "twitter_profiles.csv")

        def checkpoint():
            if cancellation_check is not None:
                cancellation_check()

        def persist(operation, *args, **kwargs):
            try:
                return operation(*args, **kwargs)
            except Exception as error:
                if cancellation_check is not None:
                    # Preserve the actual failure while distinguishing writes
                    # from ordinary generation/read failures for the owner.
                    error.preparation_write_uncertain = True
                raise

        preparation_started = False
        try:
            checkpoint()
            from .preparation_cancellation import assert_not_blocked
            try:
                assert_not_blocked(simulation_id)
            except Exception:
                # A live cancel may have written its marker after the first
                # checkpoint. Let its controller classify that accepted race.
                checkpoint()
                raise
            # A selected local cast may have changed since HTTP admission.
            # Resolve it before clearing saved flags or constructing generators.
            selected = None
            if selected_entity_ids is not None:
                from .preparation_plan import validate_planned_request
                options = validate_planned_request({
                    "simulation_id": simulation_id, "preparation_mode": "prepare",
                    "selected_entity_ids": selected_entity_ids,
                    "use_llm_for_profiles": use_llm_for_profiles,
                    "parallel_profile_count": parallel_profile_count,
                })
                parallel_profile_count = options["parallel_profile_count"]
                checkpoint()
                selected = ZepEntityReader().filter_defined_entities(
                    graph_id=state.graph_id, defined_entity_types=defined_entity_types,
                    enrich_with_edges=use_llm_for_profiles, selected_entity_ids=options["selected_entity_ids"],
                    max_nodes=max_graph_nodes, max_edges=max_graph_edges,
                )
                checkpoint()

            preparation_started = True
            state.status = SimulationStatus.PREPARING
            state.error = None
            state.profiles_generated = False
            state.config_generated = False
            state.config_reasoning = ""
            persist(self._save_simulation_state, state)
            
            # ========== 阶段1: 读取并过滤实体 ==========
            if progress_callback:
                progress_callback("reading", 0, t('progress.connectingZepGraph'))
            
            if progress_callback:
                progress_callback("reading", 30, t('progress.readingNodeData'))

            filtered = selected
            if filtered is None:
                checkpoint()
                filtered = ZepEntityReader().filter_defined_entities(
                    graph_id=state.graph_id,
                    defined_entity_types=defined_entity_types,
                    enrich_with_edges=True,
                )
                checkpoint()
            
            from ..local_runtime.oasis import validate_agent_count
            validate_agent_count(filtered.filtered_count)
            if Config.LOCAL_MODE:
                parallel_profile_count = min(parallel_profile_count, Config.LOCAL_MAX_CONCURRENCY)
            state.entities_count = filtered.filtered_count
            state.entity_types = list(filtered.entity_types)
            
            if progress_callback:
                progress_callback(
                    "reading", 100,
                    t('progress.readingComplete', count=filtered.filtered_count),
                    current=filtered.filtered_count,
                    total=filtered.filtered_count
                )
            
            if filtered.filtered_count == 0:
                state.status = SimulationStatus.FAILED
                state.error = "没有找到符合条件的实体，请检查图谱是否正确构建"
                persist(self._save_simulation_state, state)
                raise ValueError(state.error)
            
            # ========== 阶段2: 生成Agent Profile ==========
            total_entities = len(filtered.entities)
            
            if progress_callback:
                progress_callback(
                    "generating_profiles", 0,
                    t('progress.startGenerating'),
                    current=0,
                    total=total_entities
                )
            
            # 传入graph_id以启用Zep检索功能，获取更丰富的上下文
            checkpoint()
            generator = OasisProfileGenerator(graph_id=state.graph_id)
            
            def profile_progress(current, total, msg):
                if cancellation_check is not None:
                    # A collected, saved profile remains inspectable on cancel.
                    state.profiles_count = current
                if progress_callback:
                    progress_callback(
                        "generating_profiles", 
                        int(current / total * 100), 
                        msg,
                        current=current,
                        total=total,
                        item_name=msg
                    )
            
            # 设置实时保存的文件路径（优先使用 Reddit JSON 格式）
            realtime_output_path = None
            realtime_platform = "reddit"
            if state.enable_reddit:
                realtime_output_path = self._get_simulation_path(simulation_id, "reddit_profiles.json")
                realtime_platform = "reddit"
            elif state.enable_twitter:
                realtime_output_path = self._get_simulation_path(simulation_id, "twitter_profiles.csv")
                realtime_platform = "twitter"
            
            checkpoint()
            profile_options = {}
            if cancellation_check is not None:
                profile_options["cancellation_check"] = cancellation_check
            profiles = generator.generate_profiles_from_entities(
                entities=filtered.entities,
                use_llm=use_llm_for_profiles,
                progress_callback=profile_progress,
                graph_id=state.graph_id,  # 传入graph_id用于Zep检索
                parallel_count=parallel_profile_count,  # 并行生成数量
                realtime_output_path=realtime_output_path,  # 实时保存路径
                output_platform=realtime_platform,  # 输出格式
                **profile_options,
            )
            
            state.profiles_count = len(profiles)
            checkpoint()
            state.profiles_generated = len(profiles) > 0
            persist(self._save_simulation_state, state)
            
            # 保存Profile文件（注意：Twitter使用CSV格式，Reddit使用JSON格式）
            # Reddit 已经在生成过程中实时保存了，这里再保存一次确保完整性
            if progress_callback:
                progress_callback(
                    "generating_profiles", 95,
                    t('progress.savingProfiles'),
                    current=total_entities,
                    total=total_entities
                )
            
            if state.enable_reddit:
                checkpoint()
                persist(
                    generator.save_profiles,
                    profiles=profiles,
                    file_path=self._get_simulation_path(simulation_id, "reddit_profiles.json"),
                    platform="reddit"
                )
            
            if state.enable_twitter:
                checkpoint()
                # Twitter使用CSV格式！这是OASIS的要求
                persist(
                    generator.save_profiles,
                    profiles=profiles,
                    file_path=self._get_simulation_path(simulation_id, "twitter_profiles.csv"),
                    platform="twitter"
                )
            
            if progress_callback:
                progress_callback(
                    "generating_profiles", 100,
                    t('progress.profilesComplete', count=len(profiles)),
                    current=len(profiles),
                    total=len(profiles)
                )
            
            # ========== 阶段3: LLM智能生成模拟配置 ==========
            checkpoint()
            if progress_callback:
                progress_callback(
                    "generating_config", 0,
                    t('progress.analyzingRequirements'),
                    current=0,
                    total=3
                )
            
            checkpoint()
            config_generator = SimulationConfigGenerator()
            
            if progress_callback:
                progress_callback(
                    "generating_config", 30,
                    t('progress.callingLLMConfig'),
                    current=1,
                    total=3
                )
            
            checkpoint()
            config_options = {}
            if cancellation_check is not None:
                # Config progress is reported outside each stage's retry and
                # fallback handling, so cancellation stops the next stage.
                config_options["progress_callback"] = lambda *_args: checkpoint()
            sim_params = config_generator.generate_config(
                simulation_id=simulation_id,
                project_id=state.project_id,
                graph_id=state.graph_id,
                simulation_requirement=simulation_requirement,
                document_text=document_text,
                entities=filtered.entities,
                enable_twitter=state.enable_twitter,
                enable_reddit=state.enable_reddit,
                **config_options,
            )

            # This gate owns the race with cancellation. No further cooperative
            # checks run after it closes admission to final config publication.
            if begin_finalization is not None:
                begin_finalization()
            else:
                checkpoint()
            
            if progress_callback:
                progress_callback(
                    "generating_config", 70,
                    t('progress.savingConfigFiles'),
                    current=2,
                    total=3
                )
            
            # 保存配置文件
            config_path = self._get_simulation_path(simulation_id, "simulation_config.json")

            def save_config():
                with open(config_path, 'w', encoding='utf-8') as f:
                    f.write(sim_params.to_json())

            persist(save_config)
            
            state.config_generated = True
            state.config_reasoning = sim_params.generation_reasoning
            
            if progress_callback:
                progress_callback(
                    "generating_config", 100,
                    t('progress.configComplete'),
                    current=3,
                    total=3
                )
            
            # 注意：运行脚本保留在 backend/scripts/ 目录，不再复制到模拟目录
            # 启动模拟时，simulation_runner 会从 scripts/ 目录运行脚本
            
            # 更新状态
            state.status = SimulationStatus.READY
            persist(self._save_simulation_state, state)
            
            logger.info(f"模拟准备完成: {simulation_id}, "
                       f"entities={state.entities_count}, profiles={state.profiles_count}")
            
            return state
            
        except PreparationCancelled:
            state.status = SimulationStatus.CREATED
            state.error = None
            state.profiles_generated = False
            state.config_generated = False
            state.config_reasoning = ""
            # Do not disguise a storage failure as a completed cancellation;
            # the owner must keep its cleanup blocker until persistence succeeds.
            persist(self._save_simulation_state, state)
            raise
        except Exception as e:
            if not preparation_started:
                raise
            logger.error(f"模拟准备失败: {simulation_id}, error={str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            state.status = SimulationStatus.FAILED
            state.error = str(e)
            persist(self._save_simulation_state, state)
            raise
    
    def get_simulation(self, simulation_id: str) -> Optional[SimulationState]:
        """获取模拟状态"""
        return self._load_simulation_state(simulation_id)
    
    def list_simulations(self, project_id: Optional[str] = None) -> List[SimulationState]:
        """列出所有模拟"""
        simulations = []
        
        if os.path.exists(self.SIMULATION_DATA_DIR):
            for sim_id in os.listdir(self.SIMULATION_DATA_DIR):
                # 跳过隐藏文件（如 .DS_Store）和非目录文件
                try:
                    sim_path = self._get_simulation_dir(sim_id)
                    if not os.path.isdir(sim_path):
                        continue
                    state = self._load_simulation_state(sim_id)
                except StoragePathError:
                    continue
                if state:
                    if project_id is None or state.project_id == project_id:
                        simulations.append(state)
        
        return simulations
    
    def get_profiles(self, simulation_id: str, platform: str = None) -> List[Dict[str, Any]]:
        """获取模拟的Agent Profile"""
        state = self._load_simulation_state(simulation_id)
        if not state:
            raise ValueError(f"模拟不存在: {simulation_id}")

        if platform is None:
            platform = state.get_default_platform()

        if platform not in {"twitter", "reddit"}:
            raise ValueError(f"不支持的平台: {platform}")

        profile_path = self._get_simulation_path(
            simulation_id,
            "twitter_profiles.csv" if platform == "twitter" else "reddit_profiles.json",
        )
        
        if not os.path.exists(profile_path):
            return []

        if platform == "twitter":
            import csv

            with open(profile_path, 'r', encoding='utf-8', newline='') as f:
                return [normalize_twitter_profile(row) for row in csv.DictReader(f)]

        with open(profile_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def get_simulation_config(self, simulation_id: str) -> Optional[Dict[str, Any]]:
        """获取模拟配置"""
        config_path = self._get_simulation_path(simulation_id, "simulation_config.json")

        if not os.path.exists(config_path):
            return None
        
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def get_run_instructions(self, simulation_id: str) -> Dict[str, str]:
        """获取运行说明"""
        sim_dir = self._get_simulation_dir(simulation_id)
        config_path = self._get_simulation_path(simulation_id, "simulation_config.json")
        scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../scripts'))
        
        return {
            "simulation_dir": sim_dir,
            "scripts_dir": scripts_dir,
            "config_file": config_path,
            "commands": {
                "twitter": f"python {scripts_dir}/run_twitter_simulation.py --config {config_path}",
                "reddit": f"python {scripts_dir}/run_reddit_simulation.py --config {config_path}",
                "parallel": f"python {scripts_dir}/run_parallel_simulation.py --config {config_path}",
            },
            "instructions": (
                f"1. 激活conda环境: conda activate MiroFish\n"
                f"2. 运行模拟 (脚本位于 {scripts_dir}):\n"
                f"   - 单独运行Twitter: python {scripts_dir}/run_twitter_simulation.py --config {config_path}\n"
                f"   - 单独运行Reddit: python {scripts_dir}/run_reddit_simulation.py --config {config_path}\n"
                f"   - 并行运行双平台: python {scripts_dir}/run_parallel_simulation.py --config {config_path}"
            )
        }
