import {
  completeAnyWord,
  Completion,
  CompletionContext,
  CompletionResult,
  snippetCompletion
} from "@codemirror/autocomplete";
import { kotlin } from "@codemirror/legacy-modes/mode/clike";
import { EditorState, Extension } from "@codemirror/state";

/**
 * Extract built-in Kotlin keywords, primitive/java.lang types, and atoms directly
 * from CodeMirror's native `@codemirror/legacy-modes/mode/clike` definition so we
 * never duplicate language keywords manually.
 */
const CODEMIRROR_BUILTIN_KOTLIN_WORDS: string[] = Array.isArray(
  kotlin.languageData?.autocomplete
)
  ? (kotlin.languageData.autocomplete as string[]).filter((w) => /^\w+$/.test(w))
  : [];

const CODEMIRROR_BUILTIN_COMPLETIONS: Completion[] = CODEMIRROR_BUILTIN_KOTLIN_WORDS.map(
  (word): Completion => ({
    label: word,
    type: /^[A-Z]/.test(word) ? "type" : "keyword"
  })
);

/**
 * Additional Kotlin stdlib, collections, concurrency, and `kotlinx.coroutines` types
 * not included in CodeMirror's base `java.lang` type list.
 */
const KOTLIN_EXTRA_TYPES: { label: string; detail?: string }[] = [
  // Kotlin stdlib & collections
  { label: "UInt", detail: "kotlin.UInt" },
  { label: "ULong", detail: "kotlin.ULong" },
  { label: "Result", detail: "kotlin.Result<T>" },
  { label: "List", detail: "kotlin.collections.List<T>" },
  { label: "MutableList", detail: "kotlin.collections.MutableList<T>" },
  { label: "Map", detail: "kotlin.collections.Map<K, V>" },
  { label: "MutableMap", detail: "kotlin.collections.MutableMap<K, V>" },
  { label: "Set", detail: "kotlin.collections.Set<T>" },
  { label: "MutableSet", detail: "kotlin.collections.MutableSet<T>" },
  { label: "ArrayDeque", detail: "kotlin.collections.ArrayDeque<E>" },
  { label: "Sequence", detail: "kotlin.sequences.Sequence<T>" },
  { label: "Regex", detail: "kotlin.text.Regex" },
  { label: "StringBuilder", detail: "kotlin.text.StringBuilder" },
  { label: "Comparator", detail: "kotlin.Comparator<T>" },
  { label: "HashMap", detail: "java.util.HashMap<K, V>" },
  { label: "HashSet", detail: "java.util.HashSet<E>" },
  { label: "LinkedHashMap", detail: "java.util.LinkedHashMap<K, V>" },
  { label: "LinkedHashSet", detail: "java.util.LinkedHashSet<E>" },
  { label: "TreeMap", detail: "java.util.TreeMap<K, V>" },
  { label: "TreeSet", detail: "java.util.TreeSet<E>" },
  { label: "PriorityQueue", detail: "java.util.PriorityQueue<E>" },
  { label: "ConcurrentHashMap", detail: "java.util.concurrent.ConcurrentHashMap<K, V>" },
  { label: "AtomicInteger", detail: "java.util.concurrent.atomic.AtomicInteger" },
  { label: "AtomicLong", detail: "java.util.concurrent.atomic.AtomicLong" },
  { label: "AtomicBoolean", detail: "java.util.concurrent.atomic.AtomicBoolean" },
  { label: "AtomicReference", detail: "java.util.concurrent.atomic.AtomicReference<V>" },
  { label: "IllegalArgumentException", detail: "kotlin.IllegalArgumentException" },
  { label: "IllegalStateException", detail: "kotlin.IllegalStateException" },
  { label: "NoSuchElementException", detail: "kotlin.NoSuchElementException" },
  { label: "IndexOutOfBoundsException", detail: "kotlin.IndexOutOfBoundsException" },

  // kotlinx.coroutines.flow (StateFlow, SharedFlow, Flow)
  { label: "StateFlow", detail: "kotlinx.coroutines.flow.StateFlow<T>" },
  { label: "MutableStateFlow", detail: "kotlinx.coroutines.flow.MutableStateFlow<T>" },
  { label: "SharedFlow", detail: "kotlinx.coroutines.flow.SharedFlow<T>" },
  { label: "MutableSharedFlow", detail: "kotlinx.coroutines.flow.MutableSharedFlow<T>" },
  { label: "Flow", detail: "kotlinx.coroutines.flow.Flow<T>" },
  { label: "FlowCollector", detail: "kotlinx.coroutines.flow.FlowCollector<T>" },
  { label: "SharingStarted", detail: "kotlinx.coroutines.flow.SharingStarted" },
  { label: "BufferOverflow", detail: "kotlinx.coroutines.channels.BufferOverflow" },

  // kotlinx.coroutines core & synchronization
  { label: "CoroutineScope", detail: "kotlinx.coroutines.CoroutineScope" },
  { label: "MainScope", detail: "kotlinx.coroutines.MainScope" },
  { label: "GlobalScope", detail: "kotlinx.coroutines.GlobalScope" },
  { label: "Dispatchers", detail: "kotlinx.coroutines.Dispatchers" },
  { label: "CoroutineDispatcher", detail: "kotlinx.coroutines.CoroutineDispatcher" },
  { label: "CoroutineContext", detail: "kotlin.coroutines.CoroutineContext" },
  { label: "CoroutineStart", detail: "kotlinx.coroutines.CoroutineStart" },
  { label: "CoroutineName", detail: "kotlinx.coroutines.CoroutineName" },
  { label: "CoroutineExceptionHandler", detail: "kotlinx.coroutines.CoroutineExceptionHandler" },
  { label: "NonCancellable", detail: "kotlinx.coroutines.NonCancellable" },
  { label: "Job", detail: "kotlinx.coroutines.Job" },
  { label: "SupervisorJob", detail: "kotlinx.coroutines.SupervisorJob" },
  { label: "Deferred", detail: "kotlinx.coroutines.Deferred<T>" },
  { label: "CompletableDeferred", detail: "kotlinx.coroutines.CompletableDeferred<T>" },
  { label: "CancellableContinuation", detail: "kotlinx.coroutines.CancellableContinuation<T>" },
  { label: "CancellationException", detail: "kotlinx.coroutines.CancellationException" },
  { label: "Channel", detail: "kotlinx.coroutines.channels.Channel<E>" },
  { label: "SendChannel", detail: "kotlinx.coroutines.channels.SendChannel<E>" },
  { label: "ReceiveChannel", detail: "kotlinx.coroutines.channels.ReceiveChannel<E>" },
  { label: "ProducerScope", detail: "kotlinx.coroutines.channels.ProducerScope<E>" },
  { label: "Mutex", detail: "kotlinx.coroutines.sync.Mutex" },
  { label: "Semaphore", detail: "kotlinx.coroutines.sync.Semaphore" },

  // Jetpack Compose core types, layouts & Material3
  { label: "Composable", detail: "@Composable (androidx.compose.runtime.Composable)" },
  { label: "Preview", detail: "@Preview (androidx.compose.ui.tooling.preview.Preview)" },
  { label: "Stable", detail: "@Stable (androidx.compose.runtime.Stable)" },
  { label: "Immutable", detail: "@Immutable (androidx.compose.runtime.Immutable)" },
  { label: "State", detail: "androidx.compose.runtime.State<T>" },
  { label: "MutableState", detail: "androidx.compose.runtime.MutableState<T>" },
  { label: "Modifier", detail: "androidx.compose.ui.Modifier" },
  { label: "Alignment", detail: "androidx.compose.ui.Alignment" },
  { label: "Arrangement", detail: "androidx.compose.foundation.layout.Arrangement" },
  { label: "ContentScale", detail: "androidx.compose.ui.layout.ContentScale" },
  { label: "Color", detail: "androidx.compose.ui.graphics.Color" },
  { label: "Dp", detail: "androidx.compose.ui.unit.Dp" },
  { label: "TextUnit", detail: "androidx.compose.ui.unit.TextUnit" },
  { label: "TextStyle", detail: "androidx.compose.ui.text.TextStyle" },
  { label: "FontWeight", detail: "androidx.compose.ui.text.font.FontWeight" },
  { label: "MaterialTheme", detail: "androidx.compose.material3.MaterialTheme" },
  { label: "PaddingValues", detail: "androidx.compose.foundation.layout.PaddingValues" },
  { label: "LazyListScope", detail: "androidx.compose.foundation.lazy.LazyListScope" },
  { label: "LazyListState", detail: "androidx.compose.foundation.lazy.LazyListState" },
  { label: "SnackbarHostState", detail: "androidx.compose.material3.SnackbarHostState" },
  { label: "NavController", detail: "androidx.navigation.NavController" },
  { label: "NavHostController", detail: "androidx.navigation.NavHostController" },
  { label: "ViewModel", detail: "androidx.lifecycle.ViewModel" }
];

const KOTLIN_STDLIB_AND_COROUTINE_FUNCTIONS: { label: string; detail?: string }[] = [
  // kotlinx.coroutines.flow builders & factories
  { label: "MutableStateFlow", detail: "<T>(value: T) -> MutableStateFlow<T>" },
  {
    label: "MutableSharedFlow",
    detail: "<T>(replay: Int = 0, extraBufferCapacity: Int = 0, onBufferOverflow: BufferOverflow) -> MutableSharedFlow<T>"
  },
  { label: "flow", detail: "<T>(block: suspend FlowCollector<T>.() -> Unit) -> Flow<T>" },
  { label: "flowOf", detail: "<T>(vararg elements: T) -> Flow<T>" },
  { label: "emptyFlow", detail: "<T>() -> Flow<T>" },
  { label: "channelFlow", detail: "<T>(block: suspend ProducerScope<T>.() -> Unit) -> Flow<T>" },
  { label: "callbackFlow", detail: "<T>(block: suspend ProducerScope<T>.() -> Unit) -> Flow<T>" },
  { label: "combine", detail: "<T1, T2, R>(flow: Flow<T1>, flow2: Flow<T2>, transform: suspend (T1, T2) -> R) -> Flow<R>" },
  { label: "merge", detail: "<T>(vararg flows: Flow<T>) -> Flow<T>" },

  // kotlinx.coroutines builders, scopes & suspension functions
  { label: "launch", detail: "CoroutineScope.(context, start, block: suspend CoroutineScope.() -> Unit) -> Job" },
  { label: "async", detail: "CoroutineScope.<T>(context, start, block: suspend CoroutineScope.() -> T) -> Deferred<T>" },
  { label: "runBlocking", detail: "<T>(context: CoroutineContext, block: suspend CoroutineScope.() -> T) -> T" },
  { label: "withContext", detail: "suspend <T>(context: CoroutineContext, block: suspend CoroutineScope.() -> T) -> T" },
  { label: "coroutineScope", detail: "suspend <R>(block: suspend CoroutineScope.() -> R) -> R" },
  { label: "supervisorScope", detail: "suspend <R>(block: suspend CoroutineScope.() -> R) -> R" },
  { label: "withTimeout", detail: "suspend <T>(timeMillis: Long, block: suspend CoroutineScope.() -> T) -> T" },
  { label: "withTimeoutOrNull", detail: "suspend <T>(timeMillis: Long, block: suspend CoroutineScope.() -> T) -> T?" },
  { label: "delay", detail: "suspend (timeMillis: Long) -> Unit" },
  { label: "yield", detail: "suspend () -> Unit" },
  { label: "awaitAll", detail: "suspend <T>(vararg deferreds: Deferred<T>) -> List<T>" },
  { label: "joinAll", detail: "suspend (vararg jobs: Job) -> Unit" },
  { label: "suspendCancellableCoroutine", detail: "suspend <T>(block: (CancellableContinuation<T>) -> Unit) -> T" },
  { label: "awaitClose", detail: "suspend ProducerScope<*>.(block: () -> Unit = {}) -> Unit" },
  { label: "ensureActive", detail: "CoroutineScope/CoroutineContext.() -> Unit" },

  // Jetpack Compose state, side-effects, layouts & components
  { label: "remember", detail: "@Composable <T>(calculation: () -> T) -> T" },
  { label: "rememberSaveable", detail: "@Composable <T>(vararg inputs: Any?, init: () -> T) -> T" },
  { label: "rememberCoroutineScope", detail: "@Composable () -> CoroutineScope" },
  { label: "rememberUpdatedState", detail: "@Composable <T>(newValue: T) -> State<T>" },
  { label: "rememberLazyListState", detail: "@Composable () -> LazyListState" },
  { label: "mutableStateOf", detail: "<T>(value: T) -> MutableState<T>" },
  { label: "mutableIntStateOf", detail: "(value: Int) -> MutableIntState" },
  { label: "mutableLongStateOf", detail: "(value: Long) -> MutableLongState" },
  { label: "mutableFloatStateOf", detail: "(value: Float) -> MutableFloatState" },
  { label: "mutableStateListOf", detail: "<T>(vararg elements: T) -> SnapshotStateList<T>" },
  { label: "mutableStateMapOf", detail: "<K, V>(vararg pairs: Pair<K, V>) -> SnapshotStateMap<K, V>" },
  { label: "derivedStateOf", detail: "<T>(calculation: () -> T) -> State<T>" },
  { label: "produceState", detail: "@Composable <T>(initialValue: T, producer: suspend ProduceStateScope<T>.() -> Unit) -> State<T>" },
  { label: "snapshotFlow", detail: "<T>(block: () -> T) -> Flow<T>" },
  { label: "LaunchedEffect", detail: "@Composable (key1: Any?, block: suspend CoroutineScope.() -> Unit)" },
  { label: "DisposableEffect", detail: "@Composable (key1: Any?, effect: DisposableEffectScope.() -> DisposableEffectResult)" },
  { label: "SideEffect", detail: "@Composable (effect: () -> Unit)" },
  { label: "CompositionLocalProvider", detail: "@Composable (vararg values: ProvidedValue<*>, content: @Composable () -> Unit)" },
  { label: "compositionLocalOf", detail: "<T>(defaultFactory: () -> T) -> ProvidableCompositionLocal<T>" },
  { label: "staticCompositionLocalOf", detail: "<T>(defaultFactory: () -> T) -> ProvidableCompositionLocal<T>" },
  { label: "Column", detail: "@Composable (modifier: Modifier, verticalArrangement, horizontalAlignment, content)" },
  { label: "Row", detail: "@Composable (modifier: Modifier, horizontalArrangement, verticalAlignment, content)" },
  { label: "Box", detail: "@Composable (modifier: Modifier, contentAlignment: Alignment, content)" },
  { label: "BoxWithConstraints", detail: "@Composable (modifier: Modifier, content: @Composable BoxWithConstraintsScope.() -> Unit)" },
  { label: "Spacer", detail: "@Composable (modifier: Modifier)" },
  { label: "LazyColumn", detail: "@Composable (modifier: Modifier, state: LazyListState, content: LazyListScope.() -> Unit)" },
  { label: "LazyRow", detail: "@Composable (modifier: Modifier, state: LazyListState, content: LazyListScope.() -> Unit)" },
  { label: "LazyVerticalGrid", detail: "@Composable (columns: GridCells, modifier: Modifier, content: LazyGridScope.() -> Unit)" },
  { label: "items", detail: "LazyListScope.<T>(items: List<T>, key: ((T) -> Any)?, itemContent: @Composable (T) -> Unit)" },
  { label: "itemsIndexed", detail: "LazyListScope.<T>(items: List<T>, itemContent: @Composable (Int, T) -> Unit)" },
  { label: "Scaffold", detail: "@Composable (modifier: Modifier, topBar, bottomBar, floatingActionButton, content)" },
  { label: "Surface", detail: "@Composable (modifier: Modifier, shape, color, content)" },
  { label: "Card", detail: "@Composable (modifier: Modifier, shape, colors, content)" },
  { label: "Text", detail: "@Composable (text: String, modifier: Modifier, color, style)" },
  { label: "Button", detail: "@Composable (onClick: () -> Unit, modifier: Modifier, enabled: Boolean, content)" },
  { label: "OutlinedButton", detail: "@Composable (onClick: () -> Unit, modifier: Modifier, content)" },
  { label: "TextButton", detail: "@Composable (onClick: () -> Unit, modifier: Modifier, content)" },
  { label: "IconButton", detail: "@Composable (onClick: () -> Unit, modifier: Modifier, content)" },
  { label: "FloatingActionButton", detail: "@Composable (onClick: () -> Unit, modifier: Modifier, content)" },
  { label: "TextField", detail: "@Composable (value: String, onValueChange: (String) -> Unit, modifier: Modifier, label)" },
  { label: "OutlinedTextField", detail: "@Composable (value: String, onValueChange: (String) -> Unit, modifier: Modifier, label)" },
  { label: "Icon", detail: "@Composable (imageVector/painter, contentDescription: String?, modifier: Modifier)" },
  { label: "Image", detail: "@Composable (painter/imageVector, contentDescription: String?, modifier: Modifier)" },
  { label: "Checkbox", detail: "@Composable (checked: Boolean, onCheckedChange: (Boolean) -> Unit)" },
  { label: "Switch", detail: "@Composable (checked: Boolean, onCheckedChange: (Boolean) -> Unit)" },
  { label: "CircularProgressIndicator", detail: "@Composable (modifier: Modifier)" },
  { label: "LinearProgressIndicator", detail: "@Composable (modifier: Modifier)" },
  { label: "TopAppBar", detail: "@Composable (title: @Composable () -> Unit, modifier: Modifier, navigationIcon, actions)" },
  { label: "AlertDialog", detail: "@Composable (onDismissRequest, confirmButton, dismissButton, title, text)" },
  { label: "HorizontalDivider", detail: "@Composable (modifier: Modifier, thickness: Dp, color: Color)" },
  { label: "NavHost", detail: "@Composable (navController: NavHostController, startDestination: Any, builder)" },
  { label: "composable", detail: "NavGraphBuilder.(route: String, content: @Composable (NavBackStackEntry) -> Unit)" },
  { label: "stringResource", detail: "@Composable (id: Int, vararg formatArgs: Any) -> String" },
  { label: "painterResource", detail: "@Composable (id: Int) -> Painter" },

  // kotlin.stdlib & collections
  { label: "println", detail: "(message: Any?) -> Unit" },
  { label: "print", detail: "(message: Any?) -> Unit" },
  { label: "readln", detail: "() -> String" },
  { label: "readlnOrNull", detail: "() -> String?" },
  { label: "listOf", detail: "<T>(vararg elements: T) -> List<T>" },
  { label: "mutableListOf", detail: "<T>(vararg elements: T) -> MutableList<T>" },
  { label: "emptyList", detail: "<T>() -> List<T>" },
  { label: "listOfNotNull", detail: "<T : Any>(vararg elements: T?) -> List<T>" },
  { label: "mapOf", detail: "<K, V>(vararg pairs: Pair<K, V>) -> Map<K, V>" },
  { label: "mutableMapOf", detail: "<K, V>(vararg pairs: Pair<K, V>) -> MutableMap<K, V>" },
  { label: "emptyMap", detail: "<K, V>() -> Map<K, V>" },
  { label: "hashMapOf", detail: "<K, V>(vararg pairs: Pair<K, V>) -> HashMap<K, V>" },
  { label: "linkedMapOf", detail: "<K, V>(vararg pairs: Pair<K, V>) -> LinkedHashMap<K, V>" },
  { label: "setOf", detail: "<T>(vararg elements: T) -> Set<T>" },
  { label: "mutableSetOf", detail: "<T>(vararg elements: T) -> MutableSet<T>" },
  { label: "emptySet", detail: "<T>() -> Set<T>" },
  { label: "hashSetOf", detail: "<T>(vararg elements: T) -> HashSet<T>" },
  { label: "linkedSetOf", detail: "<T>(vararg elements: T) -> LinkedHashSet<T>" },
  { label: "arrayOf", detail: "<T>(vararg elements: T) -> Array<T>" },
  { label: "intArrayOf", detail: "(vararg elements: Int) -> IntArray" },
  { label: "longArrayOf", detail: "(vararg elements: Long) -> LongArray" },
  { label: "booleanArrayOf", detail: "(vararg elements: Boolean) -> BooleanArray" },
  { label: "sequence", detail: "<T>(block: suspend SequenceScope<T>.() -> Unit) -> Sequence<T>" },
  { label: "sequenceOf", detail: "<T>(vararg elements: T) -> Sequence<T>" },
  { label: "generateSequence", detail: "<T>(seed: T?, nextFunction: (T) -> T?) -> Sequence<T>" },
  { label: "buildList", detail: "<E>(builderAction: MutableList<E>.() -> Unit) -> List<E>" },
  { label: "buildMap", detail: "<K, V>(builderAction: MutableMap<K, V>.() -> Unit) -> Map<K, V>" },
  { label: "buildSet", detail: "<E>(builderAction: MutableSet<E>.() -> Unit) -> Set<E>" },
  { label: "buildString", detail: "(builderAction: StringBuilder.() -> Unit) -> String" },
  { label: "repeat", detail: "(times: Int, action: (Int) -> Unit) -> Unit" },
  { label: "require", detail: "(value: Boolean, lazyMessage: () -> Any)" },
  { label: "requireNotNull", detail: "<T : Any>(value: T?) -> T" },
  { label: "check", detail: "(value: Boolean, lazyMessage: () -> Any)" },
  { label: "checkNotNull", detail: "<T : Any>(value: T?) -> T" },
  { label: "error", detail: "(message: Any) -> Nothing" },
  { label: "TODO", detail: "(reason: String) -> Nothing" },
  { label: "runCatching", detail: "<R>(block: () -> R) -> Result<R>" },
  { label: "maxOf", detail: "(a: T, b: T) -> T" },
  { label: "minOf", detail: "(a: T, b: T) -> T" },
  { label: "lazy", detail: "<T>(initializer: () -> T) -> Lazy<T>" }
];

const KOTLIN_MEMBER_EXTENSIONS: { label: string; detail?: string; type?: string }[] = [
  // StateFlow / MutableStateFlow / SharedFlow / Flow operators & properties
  { label: "value", detail: "T (StateFlow / MutableStateFlow current value)", type: "property" },
  { label: "asStateFlow", detail: "MutableStateFlow<T>.() -> StateFlow<T>", type: "method" },
  { label: "asSharedFlow", detail: "MutableSharedFlow<T>.() -> SharedFlow<T>", type: "method" },
  { label: "asFlow", detail: "Iterable<T>/Sequence<T>.() -> Flow<T>", type: "method" },
  { label: "update", detail: "MutableStateFlow<T>.(function: (T) -> T) -> Unit", type: "method" },
  { label: "updateAndGet", detail: "MutableStateFlow<T>.(function: (T) -> T) -> T", type: "method" },
  { label: "getAndUpdate", detail: "MutableStateFlow<T>.(function: (T) -> T) -> T", type: "method" },
  { label: "compareAndSet", detail: "MutableStateFlow<T>.(expect: T, update: T) -> Boolean", type: "method" },
  { label: "subscriptionCount", detail: "StateFlow<Int>", type: "property" },
  { label: "replayCache", detail: "List<T> (SharedFlow)", type: "property" },
  { label: "emit", detail: "suspend FlowCollector<T>/MutableSharedFlow<T>.(value: T) -> Unit", type: "method" },
  { label: "tryEmit", detail: "MutableSharedFlow<T>.(value: T) -> Boolean", type: "method" },
  { label: "emitAll", detail: "suspend FlowCollector<T>.(flow: Flow<T>) -> Unit", type: "method" },
  { label: "collect", detail: "suspend Flow<T>.(collector: FlowCollector<T>) -> Unit", type: "method" },
  { label: "collectLatest", detail: "suspend Flow<T>.(action: suspend (value: T) -> Unit) -> Unit", type: "method" },
  { label: "collectIndexed", detail: "suspend Flow<T>.(action: suspend (index: Int, value: T) -> Unit)", type: "method" },
  {
    label: "stateIn",
    detail: "Flow<T>.(scope: CoroutineScope, started: SharingStarted, initialValue: T) -> StateFlow<T>",
    type: "method"
  },
  {
    label: "shareIn",
    detail: "Flow<T>.(scope: CoroutineScope, started: SharingStarted, replay: Int = 0) -> SharedFlow<T>",
    type: "method"
  },
  { label: "mapLatest", detail: "Flow<T>.(transform: suspend (T) -> R) -> Flow<R>", type: "method" },
  { label: "flatMapLatest", detail: "Flow<T>.(transform: suspend (T) -> Flow<R>) -> Flow<R>", type: "method" },
  { label: "flatMapMerge", detail: "Flow<T>.(concurrency: Int, transform: suspend (T) -> Flow<R>) -> Flow<R>", type: "method" },
  { label: "flatMapConcat", detail: "Flow<T>.(transform: suspend (T) -> Flow<R>) -> Flow<R>", type: "method" },
  { label: "transform", detail: "Flow<T>.(transform: suspend FlowCollector<R>.(T) -> Unit) -> Flow<R>", type: "method" },
  { label: "transformLatest", detail: "Flow<T>.(transform: suspend FlowCollector<R>.(T) -> Unit) -> Flow<R>", type: "method" },
  { label: "onStart", detail: "Flow<T>.(action: suspend FlowCollector<T>.() -> Unit) -> Flow<T>", type: "method" },
  { label: "onCompletion", detail: "Flow<T>.(action: suspend FlowCollector<T>.(Throwable?) -> Unit) -> Flow<T>", type: "method" },
  { label: "onEmpty", detail: "Flow<T>.(action: suspend FlowCollector<T>.() -> Unit) -> Flow<T>", type: "method" },
  { label: "catch", detail: "Flow<T>.(action: suspend FlowCollector<T>.(Throwable) -> Unit) -> Flow<T>", type: "method" },
  { label: "retry", detail: "Flow<T>.(retries: Long, predicate: suspend (Throwable) -> Boolean) -> Flow<T>", type: "method" },
  { label: "retryWhen", detail: "Flow<T>.(predicate: suspend FlowCollector<T>.(Throwable, Long) -> Boolean) -> Flow<T>", type: "method" },
  { label: "debounce", detail: "Flow<T>.(timeoutMillis: Long) -> Flow<T>", type: "method" },
  { label: "sample", detail: "Flow<T>.(periodMillis: Long) -> Flow<T>", type: "method" },
  { label: "distinctUntilChanged", detail: "Flow<T>.() -> Flow<T>", type: "method" },
  { label: "distinctUntilChangedBy", detail: "Flow<T>.(keySelector: (T) -> K) -> Flow<T>", type: "method" },
  { label: "runningFold", detail: "Flow<T>.(initial: R, operation: suspend (R, T) -> R) -> Flow<R>", type: "method" },
  { label: "runningReduce", detail: "Flow<T>.(operation: suspend (T, T) -> T) -> Flow<T>", type: "method" },
  { label: "scan", detail: "Flow<T>.(initial: R, operation: suspend (R, T) -> R) -> Flow<R>", type: "method" },
  { label: "buffer", detail: "Flow<T>.(capacity: Int, onBufferOverflow: BufferOverflow) -> Flow<T>", type: "method" },
  { label: "conflate", detail: "Flow<T>.() -> Flow<T>", type: "method" },
  { label: "flowOn", detail: "Flow<T>.(context: CoroutineContext) -> Flow<T>", type: "method" },
  { label: "cancellable", detail: "Flow<T>.() -> Flow<T>", type: "method" },
  { label: "launchIn", detail: "Flow<T>.(scope: CoroutineScope) -> Job", type: "method" },
  { label: "produceIn", detail: "Flow<T>.(scope: CoroutineScope) -> ReceiveChannel<T>", type: "method" },

  // Coroutines, Dispatchers, SharingStarted, Channels & Synchronization members
  { label: "await", detail: "suspend Deferred<T>.() -> T", type: "method" },
  { label: "join", detail: "suspend Job.() -> Unit", type: "method" },
  { label: "cancel", detail: "Job/CoroutineScope.(cause: CancellationException?) -> Unit", type: "method" },
  { label: "cancelAndJoin", detail: "suspend Job.() -> Unit", type: "method" },
  { label: "isActive", detail: "Boolean (CoroutineScope / Job)", type: "property" },
  { label: "isCompleted", detail: "Boolean (Job / Deferred)", type: "property" },
  { label: "isCancelled", detail: "Boolean (Job)", type: "property" },
  { label: "withLock", detail: "suspend Mutex.<T>(owner: Any? = null, action: () -> T) -> T", type: "method" },
  { label: "withPermit", detail: "suspend Semaphore.<T>(action: () -> T) -> T", type: "method" },
  { label: "send", detail: "suspend SendChannel<E>.(element: E) -> Unit", type: "method" },
  { label: "trySend", detail: "SendChannel<E>.(element: E) -> ChannelResult<Unit>", type: "method" },
  { label: "receive", detail: "suspend ReceiveChannel<E>.() -> E", type: "method" },
  { label: "receiveAsFlow", detail: "ReceiveChannel<E>.() -> Flow<E>", type: "method" },
  { label: "consumeAsFlow", detail: "ReceiveChannel<E>.() -> Flow<E>", type: "method" },
  { label: "IO", detail: "CoroutineDispatcher (Dispatchers.IO)", type: "property" },
  { label: "Default", detail: "CoroutineDispatcher (Dispatchers.Default)", type: "property" },
  { label: "Main", detail: "MainCoroutineDispatcher (Dispatchers.Main)", type: "property" },
  { label: "Unconfined", detail: "CoroutineDispatcher (Dispatchers.Unconfined)", type: "property" },
  {
    label: "WhileSubscribed",
    detail: "SharingStarted.(stopTimeoutMillis: Long = 0, replayExpirationMillis: Long = Long.MAX_VALUE)",
    type: "method"
  },
  { label: "Eagerly", detail: "SharingStarted (SharingStarted.Eagerly)", type: "property" },
  { label: "Lazily", detail: "SharingStarted (SharingStarted.Lazily)", type: "property" },

  // Jetpack Compose Modifier, StateFlow -> Compose & unit extensions
  { label: "collectAsState", detail: "@Composable StateFlow<T>/Flow<T>.() -> State<T>", type: "method" },
  { label: "collectAsStateWithLifecycle", detail: "@Composable StateFlow<T>/Flow<T>.() -> State<T>", type: "method" },
  { label: "fillMaxSize", detail: "Modifier.(fraction: Float = 1f) -> Modifier", type: "method" },
  { label: "fillMaxWidth", detail: "Modifier.(fraction: Float = 1f) -> Modifier", type: "method" },
  { label: "fillMaxHeight", detail: "Modifier.(fraction: Float = 1f) -> Modifier", type: "method" },
  { label: "wrapContentSize", detail: "Modifier.(align: Alignment = Alignment.Center) -> Modifier", type: "method" },
  { label: "wrapContentWidth", detail: "Modifier.() -> Modifier", type: "method" },
  { label: "wrapContentHeight", detail: "Modifier.() -> Modifier", type: "method" },
  { label: "padding", detail: "Modifier.(all: Dp / horizontal: Dp, vertical: Dp) -> Modifier", type: "method" },
  { label: "size", detail: "Modifier.(size: Dp / width: Dp, height: Dp) -> Modifier", type: "method" },
  { label: "width", detail: "Modifier.(width: Dp) -> Modifier", type: "method" },
  { label: "height", detail: "Modifier.(height: Dp) -> Modifier", type: "method" },
  { label: "weight", detail: "RowScope/ColumnScope.Modifier.(weight: Float, fill: Boolean = true) -> Modifier", type: "method" },
  { label: "align", detail: "BoxScope/ColumnScope/RowScope.Modifier.(alignment: Alignment) -> Modifier", type: "method" },
  { label: "clickable", detail: "Modifier.(enabled: Boolean = true, onClick: () -> Unit) -> Modifier", type: "method" },
  { label: "background", detail: "Modifier.(color: Color, shape: Shape = RectangleShape) -> Modifier", type: "method" },
  { label: "border", detail: "Modifier.(width: Dp, color: Color, shape: Shape) -> Modifier", type: "method" },
  { label: "clip", detail: "Modifier.(shape: Shape) -> Modifier", type: "method" },
  { label: "alpha", detail: "Modifier.(alpha: Float) -> Modifier", type: "method" },
  { label: "verticalScroll", detail: "Modifier.(state: ScrollState) -> Modifier", type: "method" },
  { label: "horizontalScroll", detail: "Modifier.(state: ScrollState) -> Modifier", type: "method" },
  { label: "animateContentSize", detail: "Modifier.() -> Modifier", type: "method" },
  { label: "semantics", detail: "Modifier.(mergeDescendants: Boolean, properties: SemanticsPropertyReceiver.() -> Unit)", type: "method" },
  { label: "testTag", detail: "Modifier.(tag: String) -> Modifier", type: "method" },
  { label: "dp", detail: "Int/Double/Float.dp -> Dp", type: "property" },
  { label: "sp", detail: "Int/Double/Float.sp -> TextUnit", type: "property" },

  // Standard library scope & collection extensions
  { label: "let", detail: "inline (T) -> R", type: "method" },
  { label: "apply", detail: "inline T.() -> T", type: "method" },
  { label: "run", detail: "inline T.() -> R", type: "method" },
  { label: "also", detail: "inline (T) -> T", type: "method" },
  { label: "takeIf", detail: "inline (T) -> Boolean", type: "method" },
  { label: "takeUnless", detail: "inline (T) -> Boolean", type: "method" },
  { label: "map", detail: "transform: (T) -> R", type: "method" },
  { label: "mapIndexed", detail: "transform: (index: Int, T) -> R", type: "method" },
  { label: "mapNotNull", detail: "transform: (T) -> R?", type: "method" },
  { label: "flatMap", detail: "transform: (T) -> Iterable<R>", type: "method" },
  { label: "filter", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "filterNot", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "filterNotNull", detail: "() -> List<T>", type: "method" },
  { label: "filterIndexed", detail: "predicate: (index: Int, T) -> Boolean", type: "method" },
  { label: "forEach", detail: "action: (T) -> Unit", type: "method" },
  { label: "forEachIndexed", detail: "action: (index: Int, T) -> Unit", type: "method" },
  { label: "onEach", detail: "action: (T) -> Unit", type: "method" },
  { label: "find", detail: "predicate: (T) -> Boolean -> T?", type: "method" },
  { label: "first", detail: "() -> T", type: "method" },
  { label: "firstOrNull", detail: "() -> T?", type: "method" },
  { label: "last", detail: "() -> T", type: "method" },
  { label: "lastOrNull", detail: "() -> T?", type: "method" },
  { label: "single", detail: "() -> T", type: "method" },
  { label: "singleOrNull", detail: "() -> T?", type: "method" },
  { label: "any", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "all", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "none", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "count", detail: "() -> Int", type: "method" },
  { label: "fold", detail: "(initial: R, operation: (acc: R, T) -> R)", type: "method" },
  { label: "reduce", detail: "(operation: (acc: S, T) -> S)", type: "method" },
  { label: "sumOf", detail: "selector: (T) -> Int/Long/Double", type: "method" },
  { label: "maxByOrNull", detail: "selector: (T) -> R", type: "method" },
  { label: "minByOrNull", detail: "selector: (T) -> R", type: "method" },
  { label: "sorted", detail: "() -> List<T>", type: "method" },
  { label: "sortedDescending", detail: "() -> List<T>", type: "method" },
  { label: "sortedBy", detail: "selector: (T) -> R?", type: "method" },
  { label: "sortedByDescending", detail: "selector: (T) -> R?", type: "method" },
  { label: "reversed", detail: "() -> List<T>", type: "method" },
  { label: "distinct", detail: "() -> List<T>", type: "method" },
  { label: "distinctBy", detail: "selector: (T) -> K", type: "method" },
  { label: "groupBy", detail: "keySelector: (T) -> K", type: "method" },
  { label: "groupingBy", detail: "keySelector: (T) -> K", type: "method" },
  { label: "associate", detail: "transform: (T) -> Pair<K, V>", type: "method" },
  { label: "associateBy", detail: "keySelector: (T) -> K", type: "method" },
  { label: "associateWith", detail: "valueSelector: (T) -> V", type: "method" },
  { label: "partition", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "chunked", detail: "(size: Int) -> List<List<T>>", type: "method" },
  { label: "windowed", detail: "(size: Int, step: Int = 1)", type: "method" },
  { label: "zip", detail: "(other: Iterable<R>) -> List<Pair<T, R>>", type: "method" },
  { label: "withIndex", detail: "() -> Iterable<IndexedValue<T>>", type: "method" },
  { label: "joinToString", detail: "(separator: CharSequence = \", \") -> String", type: "method" },
  { label: "take", detail: "(n: Int) -> List<T>/Flow<T>", type: "method" },
  { label: "takeWhile", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "drop", detail: "(n: Int) -> List<T>/Flow<T>", type: "method" },
  { label: "dropWhile", detail: "predicate: (T) -> Boolean", type: "method" },
  { label: "toList", detail: "() -> List<T>", type: "method" },
  { label: "toMutableList", detail: "() -> MutableList<T>", type: "method" },
  { label: "toSet", detail: "() -> Set<T>", type: "method" },
  { label: "toMutableSet", detail: "() -> MutableSet<T>", type: "method" },
  { label: "toMap", detail: "() -> Map<K, V>", type: "method" },
  { label: "toIntArray", detail: "() -> IntArray", type: "method" },
  { label: "asSequence", detail: "() -> Sequence<T>", type: "method" },
  { label: "isEmpty", detail: "() -> Boolean", type: "method" },
  { label: "isNotEmpty", detail: "() -> Boolean", type: "method" },
  { label: "isNullOrEmpty", detail: "() -> Boolean", type: "method" },
  { label: "isNullOrBlank", detail: "() -> Boolean", type: "method" },
  { label: "orEmpty", detail: "() -> T", type: "method" },
  { label: "getOrNull", detail: "(index: Int) -> T?", type: "method" },
  { label: "getOrDefault", detail: "(key: K, defaultValue: V) -> V", type: "method" },
  { label: "getOrElse", detail: "(key: K, defaultValue: () -> V) -> V", type: "method" },
  { label: "getOrPut", detail: "(key: K, defaultValue: () -> V) -> V", type: "method" },
  { label: "putIfAbsent", detail: "(key: K, value: V) -> V?", type: "method" },
  { label: "containsKey", detail: "(key: K) -> Boolean", type: "method" },
  { label: "containsValue", detail: "(value: V) -> Boolean", type: "method" },
  { label: "contains", detail: "(element: T) -> Boolean", type: "method" },
  { label: "add", detail: "(element: T) -> Boolean", type: "method" },
  { label: "addAll", detail: "(elements: Collection<T>) -> Boolean", type: "method" },
  { label: "remove", detail: "(element: T) -> Boolean", type: "method" },
  { label: "removeFirst", detail: "() -> T", type: "method" },
  { label: "removeLast", detail: "() -> T", type: "method" },
  { label: "addFirst", detail: "(element: T) -> Unit", type: "method" },
  { label: "addLast", detail: "(element: T) -> Unit", type: "method" },
  { label: "trim", detail: "() -> String", type: "method" },
  { label: "split", detail: "(vararg delimiters: String) -> List<String>", type: "method" },
  { label: "lines", detail: "() -> List<String>", type: "method" },
  { label: "substring", detail: "(startIndex: Int, endIndex: Int) -> String", type: "method" },
  { label: "replace", detail: "(oldValue: String, newValue: String) -> String", type: "method" },
  { label: "startsWith", detail: "(prefix: String) -> Boolean", type: "method" },
  { label: "endsWith", detail: "(suffix: String) -> Boolean", type: "method" },
  { label: "lowercase", detail: "() -> String", type: "method" },
  { label: "uppercase", detail: "() -> String", type: "method" },
  { label: "toInt", detail: "() -> Int", type: "method" },
  { label: "toIntOrNull", detail: "() -> Int?", type: "method" },
  { label: "toLong", detail: "() -> Long", type: "method" },
  { label: "toLongOrNull", detail: "() -> Long?", type: "method" },
  { label: "toDouble", detail: "() -> Double", type: "method" },
  { label: "toDoubleOrNull", detail: "() -> Double?", type: "method" },
  { label: "size", detail: "Int", type: "property" },
  { label: "length", detail: "Int", type: "property" },
  { label: "indices", detail: "IntRange", type: "property" },
  { label: "lastIndex", detail: "Int", type: "property" },
  { label: "keys", detail: "Set<K>", type: "property" },
  { label: "values", detail: "Collection<V>", type: "property" },
  { label: "entries", detail: "Set<Map.Entry<K, V>>", type: "property" }
];

const KOTLIN_SNIPPETS: Completion[] = [
  snippetCompletion(
    "@Composable\nfun ${ComponentName}(\n  modifier: Modifier = Modifier\n) {\n  ${}\n}",
    {
      label: "composable",
      detail: "@Composable function declaration",
      type: "function",
      boost: 3
    }
  ),
  snippetCompletion("var ${state} by remember { mutableStateOf(${initialValue}) }", {
    label: "remstate",
    detail: "remember { mutableStateOf(...) } delegated state",
    type: "variable",
    boost: 3
  }),
  snippetCompletion(
    "private val _${state} = MutableStateFlow(${initialValue})\nval ${state}: StateFlow<${Type}> = _${state}.asStateFlow()",
    {
      label: "stateflow",
      detail: "MutableStateFlow + read-only StateFlow backing property",
      type: "variable",
      boost: 3
    }
  ),
  snippetCompletion(
    "private val _${events} = MutableSharedFlow<${Event}>()\nval ${events}: SharedFlow<${Event}> = _${events}.asSharedFlow()",
    {
      label: "sharedflow",
      detail: "MutableSharedFlow + read-only SharedFlow backing property",
      type: "variable",
      boost: 3
    }
  ),
  snippetCompletion("fun ${name}(${params}): ${Unit} {\n  ${}\n}", {
    label: "fun",
    detail: "function declaration",
    type: "keyword",
    boost: 2
  }),
  snippetCompletion("suspend fun ${name}(${params}): ${Unit} {\n  ${}\n}", {
    label: "suspend fun",
    detail: "suspend function declaration",
    type: "keyword",
    boost: 2
  }),
  snippetCompletion("fun main() {\n  ${}\n}", {
    label: "main",
    detail: "fun main() entry point",
    type: "function",
    boost: 2
  }),
  snippetCompletion("data class ${Name}(val ${prop}: ${Type})", {
    label: "dataclass",
    detail: "data class declaration",
    type: "class",
    boost: 2
  }),
  snippetCompletion("sealed interface ${Name} {\n  ${}\n}", {
    label: "sealed",
    detail: "sealed interface declaration",
    type: "interface",
    boost: 1
  }),
  snippetCompletion("when (${expr}) {\n  ${cond} -> ${}\n  else -> ${}\n}", {
    label: "when",
    detail: "when expression",
    type: "keyword",
    boost: 1
  }),
  snippetCompletion("for (${i} in ${0} until ${n}) {\n  ${}\n}", {
    label: "fori",
    detail: "indexed range loop",
    type: "keyword",
    boost: 1
  })
];

const KOTLIN_ANNOTATIONS: Completion[] = [
  { label: "@Composable", detail: "androidx.compose.runtime.Composable", type: "keyword", boost: 3 },
  { label: "@Preview", detail: "androidx.compose.ui.tooling.preview.Preview", type: "keyword", boost: 2 },
  { label: "@Stable", detail: "androidx.compose.runtime.Stable", type: "keyword" },
  { label: "@Immutable", detail: "androidx.compose.runtime.Immutable", type: "keyword" },
  { label: "@OptIn", detail: "kotlin.OptIn", type: "keyword" },
  { label: "@Suppress", detail: "kotlin.Suppress", type: "keyword" },
  { label: "@JvmInline", detail: "kotlin.jvm.JvmInline", type: "keyword" }
];

export const KOTLIN_DOT_COMPLETIONS: Completion[] = KOTLIN_MEMBER_EXTENSIONS.map((item) => ({
  label: item.label,
  detail: item.detail,
  type: item.type || "method"
}));

export const KOTLIN_TOP_LEVEL_COMPLETIONS: Completion[] = [
  ...KOTLIN_SNIPPETS,
  ...KOTLIN_ANNOTATIONS,
  ...CODEMIRROR_BUILTIN_COMPLETIONS,
  ...KOTLIN_EXTRA_TYPES.map(
    (t): Completion => ({ label: t.label, detail: t.detail, type: "type" })
  ),
  ...KOTLIN_STDLIB_AND_COROUTINE_FUNCTIONS.map(
    (fn): Completion => ({ label: fn.label, detail: fn.detail, type: "function" })
  ),
  ...KOTLIN_DOT_COMPLETIONS
];

/**
 * Custom CodeMirror 6 CompletionSource for Kotlin & Jetpack Compose:
 * - Suggests member/extension methods, Flow operators, and Compose Modifier chains after '.'
 * - Suggests @Composable / @Preview annotations on '@'
 * - Suggests Kotlin keywords, stdlib, Coroutines, Jetpack Compose APIs, and snippets on identifier input
 */
export function kotlinCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const dotMatch = context.matchBefore(/\.\w*$/);
  if (dotMatch) {
    return {
      from: dotMatch.from + 1,
      options: KOTLIN_DOT_COMPLETIONS,
      validFor: /^\w*$/
    };
  }

  const atMatch = context.matchBefore(/@\w*$/);
  if (atMatch) {
    return {
      from: atMatch.from,
      options: KOTLIN_ANNOTATIONS,
      validFor: /^@\w*$/
    };
  }

  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit)) {
    return null;
  }

  return {
    from: word.from,
    options: KOTLIN_TOP_LEVEL_COMPLETIONS,
    validFor: /^\w*$/
  };
}

/**
 * Swift + SwiftUI Completion Catalog
 */
const SWIFT_KEYWORDS: string[] = [
  "func",
  "let",
  "var",
  "struct",
  "class",
  "enum",
  "protocol",
  "actor",
  "extension",
  "typealias",
  "associatedtype",
  "import",
  "init",
  "deinit",
  "subscript",
  "if",
  "else",
  "guard",
  "switch",
  "case",
  "default",
  "for",
  "in",
  "while",
  "repeat",
  "break",
  "continue",
  "fallthrough",
  "return",
  "defer",
  "do",
  "try",
  "catch",
  "throw",
  "throws",
  "rethrows",
  "async",
  "await",
  "some",
  "any",
  "where",
  "as",
  "is",
  "nil",
  "true",
  "false",
  "self",
  "Self",
  "super",
  "private",
  "fileprivate",
  "internal",
  "public",
  "open",
  "static",
  "final",
  "override",
  "mutating",
  "nonmutating",
  "lazy",
  "weak",
  "unowned",
  "inout",
  "isolated",
  "nonisolated",
  "willSet",
  "didSet",
  "get",
  "set"
];

const SWIFT_ATTRIBUTES: Completion[] = [
  { label: "@State", detail: "SwiftUI @State property wrapper", type: "keyword", boost: 3 },
  { label: "@Binding", detail: "SwiftUI @Binding property wrapper", type: "keyword", boost: 3 },
  { label: "@StateObject", detail: "SwiftUI @StateObject property wrapper", type: "keyword", boost: 3 },
  { label: "@ObservedObject", detail: "SwiftUI @ObservedObject property wrapper", type: "keyword", boost: 3 },
  { label: "@EnvironmentObject", detail: "SwiftUI @EnvironmentObject property wrapper", type: "keyword", boost: 2 },
  { label: "@Environment", detail: "SwiftUI @Environment(\\.keyPath) property wrapper", type: "keyword", boost: 2 },
  { label: "@Published", detail: "Combine @Published property wrapper", type: "keyword", boost: 2 },
  { label: "@Observable", detail: "Observation @Observable macro", type: "keyword", boost: 3 },
  { label: "@Bindable", detail: "SwiftUI @Bindable property wrapper", type: "keyword", boost: 2 },
  { label: "@FocusState", detail: "SwiftUI @FocusState property wrapper", type: "keyword" },
  { label: "@AppStorage", detail: "SwiftUI @AppStorage property wrapper", type: "keyword" },
  { label: "@ViewBuilder", detail: "SwiftUI @ViewBuilder result builder", type: "keyword", boost: 2 },
  { label: "@MainActor", detail: "Swift Concurrency @MainActor global actor", type: "keyword", boost: 2 },
  { label: "@escaping", detail: "Escaping closure attribute", type: "keyword" },
  { label: "@Sendable", detail: "Sendable closure attribute", type: "keyword" },
  { label: "@discardableResult", detail: "Ignore unused return value warning", type: "keyword" }
];

const SWIFT_TYPES_AND_VIEWS: { label: string; detail?: string }[] = [
  // Swift Standard Library & Concurrency
  { label: "String", detail: "Swift.String" },
  { label: "Int", detail: "Swift.Int" },
  { label: "Double", detail: "Swift.Double" },
  { label: "Float", detail: "Swift.Float" },
  { label: "Bool", detail: "Swift.Bool" },
  { label: "Character", detail: "Swift.Character" },
  { label: "Array", detail: "Swift.Array<Element>" },
  { label: "Dictionary", detail: "Swift.Dictionary<Key, Value>" },
  { label: "Set", detail: "Swift.Set<Element>" },
  { label: "Optional", detail: "Swift.Optional<Wrapped>" },
  { label: "Result", detail: "Swift.Result<Success, Failure>" },
  { label: "Error", detail: "Swift.Error" },
  { label: "Void", detail: "Swift.Void" },
  { label: "Never", detail: "Swift.Never" },
  { label: "Any", detail: "Swift.Any" },
  { label: "AnyObject", detail: "Swift.AnyObject" },
  { label: "Codable", detail: "Decodable & Encodable" },
  { label: "Encodable", detail: "Swift.Encodable" },
  { label: "Decodable", detail: "Swift.Decodable" },
  { label: "Equatable", detail: "Swift.Equatable" },
  { label: "Hashable", detail: "Swift.Hashable" },
  { label: "Comparable", detail: "Swift.Comparable" },
  { label: "Identifiable", detail: "Swift.Identifiable" },
  { label: "Sendable", detail: "Swift.Sendable" },
  { label: "CaseIterable", detail: "Swift.CaseIterable" },
  { label: "Task", detail: "Swift Concurrency Task<Success, Failure>" },
  { label: "TaskGroup", detail: "Swift Concurrency TaskGroup<ChildTaskResult>" },
  { label: "MainActor", detail: "Swift Concurrency MainActor" },
  { label: "AsyncStream", detail: "Swift Concurrency AsyncStream<Element>" },
  { label: "AsyncSequence", detail: "Swift Concurrency AsyncSequence" },
  { label: "CheckedContinuation", detail: "Swift Concurrency CheckedContinuation<T, E>" },
  { label: "URL", detail: "Foundation.URL" },
  { label: "URLRequest", detail: "Foundation.URLRequest" },
  { label: "URLSession", detail: "Foundation.URLSession" },
  { label: "JSONDecoder", detail: "Foundation.JSONDecoder" },
  { label: "JSONEncoder", detail: "Foundation.JSONEncoder" },
  { label: "UUID", detail: "Foundation.UUID" },
  { label: "Date", detail: "Foundation.Date" },
  { label: "Data", detail: "Foundation.Data" },
  { label: "ObservableObject", detail: "Combine.ObservableObject" },
  { label: "AnyCancellable", detail: "Combine.AnyCancellable" },
  { label: "PassthroughSubject", detail: "Combine.PassthroughSubject<Output, Failure>" },
  { label: "CurrentValueSubject", detail: "Combine.CurrentValueSubject<Output, Failure>" },

  // SwiftUI Views, Containers & Types
  { label: "View", detail: "SwiftUI.View protocol" },
  { label: "App", detail: "SwiftUI.App protocol" },
  { label: "Scene", detail: "SwiftUI.Scene protocol" },
  { label: "WindowGroup", detail: "SwiftUI.WindowGroup" },
  { label: "ViewModifier", detail: "SwiftUI.ViewModifier protocol" },
  { label: "VStack", detail: "SwiftUI.VStack(alignment:spacing:content:)" },
  { label: "HStack", detail: "SwiftUI.HStack(alignment:spacing:content:)" },
  { label: "ZStack", detail: "SwiftUI.ZStack(alignment:content:)" },
  { label: "LazyVStack", detail: "SwiftUI.LazyVStack(alignment:spacing:content:)" },
  { label: "LazyHStack", detail: "SwiftUI.LazyHStack(alignment:spacing:content:)" },
  { label: "LazyVGrid", detail: "SwiftUI.LazyVGrid(columns:spacing:content:)" },
  { label: "LazyHGrid", detail: "SwiftUI.LazyHGrid(rows:spacing:content:)" },
  { label: "GridItem", detail: "SwiftUI.GridItem(.flexible() / .adaptive())" },
  { label: "List", detail: "SwiftUI.List" },
  { label: "ForEach", detail: "SwiftUI.ForEach(data, id:content:)" },
  { label: "ScrollView", detail: "SwiftUI.ScrollView(axes, showsIndicators:content:)" },
  { label: "NavigationStack", detail: "SwiftUI.NavigationStack(path:root:)" },
  { label: "NavigationSplitView", detail: "SwiftUI.NavigationSplitView(sidebar:detail:)" },
  { label: "NavigationLink", detail: "SwiftUI.NavigationLink(value:label:)" },
  { label: "NavigationPath", detail: "SwiftUI.NavigationPath" },
  { label: "TabView", detail: "SwiftUI.TabView" },
  { label: "Form", detail: "SwiftUI.Form" },
  { label: "Section", detail: "SwiftUI.Section" },
  { label: "Group", detail: "SwiftUI.Group" },
  { label: "GeometryReader", detail: "SwiftUI.GeometryReader { proxy in ... }" },
  { label: "Text", detail: "SwiftUI.Text(String)" },
  { label: "Label", detail: "SwiftUI.Label(title, systemImage:)" },
  { label: "Image", detail: "SwiftUI.Image(systemName:)" },
  { label: "AsyncImage", detail: "SwiftUI.AsyncImage(url:)" },
  { label: "Button", detail: "SwiftUI.Button(action:label:)" },
  { label: "TextField", detail: "SwiftUI.TextField(title, text: $binding)" },
  { label: "SecureField", detail: "SwiftUI.SecureField(title, text: $binding)" },
  { label: "TextEditor", detail: "SwiftUI.TextEditor(text: $binding)" },
  { label: "Toggle", detail: "SwiftUI.Toggle(title, isOn: $binding)" },
  { label: "Slider", detail: "SwiftUI.Slider(value: $binding, in: range)" },
  { label: "Picker", detail: "SwiftUI.Picker(title, selection: $binding)" },
  { label: "DatePicker", detail: "SwiftUI.DatePicker(title, selection: $binding)" },
  { label: "ProgressView", detail: "SwiftUI.ProgressView()" },
  { label: "Spacer", detail: "SwiftUI.Spacer()" },
  { label: "Divider", detail: "SwiftUI.Divider()" },
  { label: "EmptyView", detail: "SwiftUI.EmptyView()" },
  { label: "Color", detail: "SwiftUI.Color" },
  { label: "Font", detail: "SwiftUI.Font" },
  { label: "Alignment", detail: "SwiftUI.Alignment" },
  { label: "HorizontalAlignment", detail: "SwiftUI.HorizontalAlignment" },
  { label: "VerticalAlignment", detail: "SwiftUI.VerticalAlignment" },
  { label: "EdgeInsets", detail: "SwiftUI.EdgeInsets" },
  { label: "RoundedRectangle", detail: "SwiftUI.RoundedRectangle(cornerRadius:)" },
  { label: "Circle", detail: "SwiftUI.Circle()" },
  { label: "Capsule", detail: "SwiftUI.Capsule()" },
  { label: "Animation", detail: "SwiftUI.Animation" },
  { label: "AnyTransition", detail: "SwiftUI.AnyTransition" },
  { label: "Binding", detail: "SwiftUI.Binding<Value>" },
  { label: "State", detail: "SwiftUI.State<Value>" },
  { label: "StateObject", detail: "SwiftUI.StateObject<ObjectType>" },
  { label: "ObservedObject", detail: "SwiftUI.ObservedObject<ObjectType>" },
  { label: "EnvironmentObject", detail: "SwiftUI.EnvironmentObject<ObjectType>" }
];

const SWIFT_FUNCTIONS: { label: string; detail?: string }[] = [
  { label: "print", detail: "(_ items: Any...) -> Void" },
  { label: "debugPrint", detail: "(_ items: Any...) -> Void" },
  { label: "precondition", detail: "(_ condition: Bool, _ message: String)" },
  { label: "assert", detail: "(_ condition: Bool, _ message: String)" },
  { label: "fatalError", detail: "(_ message: String) -> Never" },
  { label: "withAnimation", detail: "SwiftUI.withAnimation(_ animation: Animation?, _ body: () throws -> Result)" },
  { label: "withTaskGroup", detail: "withTaskGroup(of: ChildTaskResult.Type, body:)" },
  { label: "withThrowingTaskGroup", detail: "withThrowingTaskGroup(of: ChildTaskResult.Type, body:)" },
  { label: "withCheckedContinuation", detail: "withCheckedContinuation { continuation in ... }" },
  { label: "withCheckedThrowingContinuation", detail: "withCheckedThrowingContinuation { continuation in ... }" },
  { label: "stride", detail: "stride(from: start, to/through: end, by: step)" },
  { label: "zip", detail: "zip(_ sequence1: S1, _ sequence2: S2)" },
  { label: "min", detail: "min(_ x: T, _ y: T) -> T" },
  { label: "max", detail: "max(_ x: T, _ y: T) -> T" },
  { label: "abs", detail: "abs(_ x: T) -> T" }
];

const SWIFT_MEMBER_MODIFIERS: { label: string; detail?: string; type?: string }[] = [
  // SwiftUI View Modifiers
  { label: "padding", detail: "View.padding(_ edges: Edge.Set = .all, _ length: CGFloat? = nil) -> some View", type: "method" },
  { label: "frame", detail: "View.frame(width:height:alignment:) / frame(maxWidth:maxHeight:alignment:)", type: "method" },
  { label: "background", detail: "View.background(_ style: some ShapeStyle / View) -> some View", type: "method" },
  { label: "foregroundStyle", detail: "View.foregroundStyle(_ style: some ShapeStyle) -> some View", type: "method" },
  { label: "foregroundColor", detail: "View.foregroundColor(_ color: Color?) -> some View", type: "method" },
  { label: "font", detail: "View.font(_ font: Font?) -> some View", type: "method" },
  { label: "fontWeight", detail: "View.fontWeight(_ weight: Font.Weight?) -> some View", type: "method" },
  { label: "bold", detail: "View.bold(_ isActive: Bool = true) -> some View", type: "method" },
  { label: "italic", detail: "View.italic(_ isActive: Bool = true) -> some View", type: "method" },
  { label: "multilineTextAlignment", detail: "View.multilineTextAlignment(_ alignment: TextAlignment)", type: "method" },
  { label: "lineLimit", detail: "View.lineLimit(_ number: Int?) -> some View", type: "method" },
  { label: "cornerRadius", detail: "View.cornerRadius(_ radius: CGFloat) -> some View", type: "method" },
  { label: "clipShape", detail: "View.clipShape(_ shape: some Shape) -> some View", type: "method" },
  { label: "clipped", detail: "View.clipped() -> some View", type: "method" },
  { label: "overlay", detail: "View.overlay(alignment:content:) -> some View", type: "method" },
  { label: "border", detail: "View.border(_ content: some ShapeStyle, width: CGFloat = 1) -> some View", type: "method" },
  { label: "shadow", detail: "View.shadow(color:radius:x:y:) -> some View", type: "method" },
  { label: "opacity", detail: "View.opacity(_ opacity: Double) -> some View", type: "method" },
  { label: "disabled", detail: "View.disabled(_ disabled: Bool) -> some View", type: "method" },
  { label: "hidden", detail: "View.hidden() -> some View", type: "method" },
  { label: "onAppear", detail: "View.onAppear(perform action: (() -> Void)? = nil) -> some View", type: "method" },
  { label: "onDisappear", detail: "View.onDisappear(perform action: (() -> Void)? = nil) -> some View", type: "method" },
  { label: "task", detail: "View.task(id:priority:_ action: @Sendable () async -> Void) -> some View", type: "method" },
  { label: "onChange", detail: "View.onChange(of value: V, perform: { oldValue, newValue in ... })", type: "method" },
  { label: "onReceive", detail: "View.onReceive(_ publisher: P, perform: (P.Output) -> Void)", type: "method" },
  { label: "onTapGesture", detail: "View.onTapGesture(count: Int = 1, perform: () -> Void)", type: "method" },
  { label: "sheet", detail: "View.sheet(isPresented: $binding / item: $item, content:)", type: "method" },
  { label: "fullScreenCover", detail: "View.fullScreenCover(isPresented: $binding, content:)", type: "method" },
  { label: "popover", detail: "View.popover(isPresented: $binding, content:)", type: "method" },
  { label: "alert", detail: "View.alert(_ titleKey: String, isPresented: $binding, actions:message:)", type: "method" },
  { label: "confirmationDialog", detail: "View.confirmationDialog(_ titleKey: String, isPresented: $binding, actions:)", type: "method" },
  { label: "navigationTitle", detail: "View.navigationTitle(_ title: String) -> some View", type: "method" },
  { label: "navigationBarTitleDisplayMode", detail: "View.navigationBarTitleDisplayMode(_ displayMode: TitleDisplayMode)", type: "method" },
  { label: "navigationDestination", detail: "View.navigationDestination(for data: D.Type, destination: (D) -> View)", type: "method" },
  { label: "toolbar", detail: "View.toolbar { ToolbarItem(...) { ... } }", type: "method" },
  { label: "searchable", detail: "View.searchable(text: $query, prompt: String) -> some View", type: "method" },
  { label: "refreshable", detail: "View.refreshable { await load() } -> some View", type: "method" },
  { label: "swipeActions", detail: "View.swipeActions(edge:allowsFullSwipe:content:)", type: "method" },
  { label: "listStyle", detail: "View.listStyle(_ style: some ListStyle) -> some View", type: "method" },
  { label: "buttonStyle", detail: "View.buttonStyle(_ style: some ButtonStyle) -> some View", type: "method" },
  { label: "textFieldStyle", detail: "View.textFieldStyle(_ style: some TextFieldStyle) -> some View", type: "method" },
  { label: "animation", detail: "View.animation(_ animation: Animation?, value: V) -> some View", type: "method" },
  { label: "transition", detail: "View.transition(_ t: AnyTransition) -> some View", type: "method" },
  { label: "contentShape", detail: "View.contentShape(_ shape: some Shape) -> some View", type: "method" },
  { label: "ignoresSafeArea", detail: "View.ignoresSafeArea(_ regions: SafeAreaRegions = .all, edges: Edge.Set = .all)", type: "method" },
  { label: "safeAreaInset", detail: "View.safeAreaInset(edge: VerticalEdge, content:)", type: "method" },
  { label: "environment", detail: "View.environment(_ keyPath: WritableKeyPath<EnvironmentValues, V>, _ value: V)", type: "method" },
  { label: "environmentObject", detail: "View.environmentObject(_ object: ObservableObject) -> some View", type: "method" },
  { label: "tag", detail: "View.tag(_ tag: V) -> some View", type: "method" },
  { label: "id", detail: "View.id(_ id: ID) -> some View", type: "method" },
  { label: "accessibilityLabel", detail: "View.accessibilityLabel(_ label: String) -> some View", type: "method" },
  { label: "accessibilityIdentifier", detail: "View.accessibilityIdentifier(_ identifier: String) -> some View", type: "method" },
  { label: "resizable", detail: "Image.resizable() -> Image", type: "method" },
  { label: "scaledToFit", detail: "View.scaledToFit() -> some View", type: "method" },
  { label: "scaledToFill", detail: "View.scaledToFill() -> some View", type: "method" },
  { label: "aspectRatio", detail: "View.aspectRatio(_ aspectRatio: CGFloat?, contentMode: ContentMode)", type: "method" },

  // Swift Standard Library Collection / Sequence / Concurrency methods & properties
  { label: "map", detail: "transform: (Element) throws -> T -> [T]", type: "method" },
  { label: "compactMap", detail: "transform: (Element) throws -> ElementOfResult? -> [ElementOfResult]", type: "method" },
  { label: "flatMap", detail: "transform: (Element) throws -> SegmentOfResult -> [SegmentOfResult.Element]", type: "method" },
  { label: "filter", detail: "isIncluded: (Element) throws -> Bool -> [Element]", type: "method" },
  { label: "forEach", detail: "body: (Element) throws -> Void", type: "method" },
  { label: "reduce", detail: "(_ initialResult: Result, _ nextPartialResult: (Result, Element) -> Result)", type: "method" },
  { label: "sorted", detail: "by areInIncreasingOrder: (Element, Element) -> Bool -> [Element]", type: "method" },
  { label: "first", detail: "where predicate: (Element) -> Bool -> Element?", type: "method" },
  { label: "last", detail: "where predicate: (Element) -> Bool -> Element?", type: "method" },
  { label: "contains", detail: "where predicate: (Element) -> Bool -> Bool", type: "method" },
  { label: "allSatisfy", detail: "(_ predicate: (Element) -> Bool) -> Bool", type: "method" },
  { label: "enumerated", detail: "() -> EnumeratedSequence<Self>", type: "method" },
  { label: "prefix", detail: "(_ maxLength: Int) -> SubSequence", type: "method" },
  { label: "suffix", detail: "(_ maxLength: Int) -> SubSequence", type: "method" },
  { label: "dropFirst", detail: "(_ k: Int = 1) -> SubSequence", type: "method" },
  { label: "dropLast", detail: "(_ k: Int = 1) -> SubSequence", type: "method" },
  { label: "append", detail: "(_ newElement: Element)", type: "method" },
  { label: "removeFirst", detail: "() -> Element", type: "method" },
  { label: "removeLast", detail: "() -> Element", type: "method" },
  { label: "removeAll", detail: "(where shouldBeRemoved: (Element) -> Bool)", type: "method" },
  { label: "joined", detail: "(separator: String = \"\") -> String", type: "method" },
  { label: "split", detail: "(separator: Character) -> [Substring]", type: "method" },
  { label: "lowercased", detail: "() -> String", type: "method" },
  { label: "uppercased", detail: "() -> String", type: "method" },
  { label: "trimmingCharacters", detail: "(in set: CharacterSet) -> String", type: "method" },
  { label: "count", detail: "Int", type: "property" },
  { label: "isEmpty", detail: "Bool", type: "property" },
  { label: "indices", detail: "Indices", type: "property" },
  { label: "value", detail: "Success (Task.value)", type: "property" },
  { label: "cancel", detail: "Task.cancel()", type: "method" },
  { label: "isCancelled", detail: "Bool (Task.isCancelled)", type: "property" },
  { label: "sleep", detail: "Task.sleep(for: .milliseconds(...))", type: "method" },
  { label: "shared", detail: "URLSession.shared", type: "property" },
  { label: "data", detail: "URLSession.data(from url: URL) async throws -> (Data, URLResponse)", type: "method" },
  { label: "decode", detail: "JSONDecoder.decode(_ type: T.Type, from data: Data) throws -> T", type: "method" },
  { label: "encode", detail: "JSONEncoder.encode(_ value: T) throws -> Data", type: "method" }
];

const SWIFT_SNIPPETS: Completion[] = [
  snippetCompletion(
    "struct ${ContentView}: View {\n  @State private var ${count} = ${0}\n\n  var body: some View {\n    VStack(spacing: 16) {\n      ${Text(\"Hello, SwiftUI!\")}\n    }\n    .padding()\n  }\n}",
    {
      label: "swiftui",
      detail: "SwiftUI View struct with @State and body",
      type: "class",
      boost: 3
    }
  ),
  snippetCompletion(
    "var body: some View {\n  ${}\n}",
    {
      label: "body",
      detail: "var body: some View { ... }",
      type: "property",
      boost: 3
    }
  ),
  snippetCompletion("func ${name}(${params}) -> ${Void} {\n  ${}\n}", {
    label: "func",
    detail: "function declaration",
    type: "keyword",
    boost: 2
  }),
  snippetCompletion("guard let ${value} = ${optional} else {\n  return\n}", {
    label: "guardlet",
    detail: "guard let unwrap statement",
    type: "keyword",
    boost: 2
  })
];

export const SWIFT_DOT_COMPLETIONS: Completion[] = SWIFT_MEMBER_MODIFIERS.map((item) => ({
  label: item.label,
  detail: item.detail,
  type: item.type || "method"
}));

export const SWIFT_TOP_LEVEL_COMPLETIONS: Completion[] = [
  ...SWIFT_SNIPPETS,
  ...SWIFT_ATTRIBUTES,
  ...SWIFT_KEYWORDS.map((kw): Completion => ({ label: kw, type: "keyword" })),
  ...SWIFT_TYPES_AND_VIEWS.map(
    (t): Completion => ({ label: t.label, detail: t.detail, type: "type" })
  ),
  ...SWIFT_FUNCTIONS.map(
    (fn): Completion => ({ label: fn.label, detail: fn.detail, type: "function" })
  ),
  ...SWIFT_DOT_COMPLETIONS
];

/**
 * Custom CodeMirror 6 CompletionSource for Swift & SwiftUI:
 * - Suggests SwiftUI View modifiers and Swift stdlib methods after '.'
 * - Suggests @State, @Binding, @Observable, @MainActor attributes on '@'
 * - Suggests Swift keywords, types, SwiftUI Views, and snippets on identifier input
 */
export function swiftCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const dotMatch = context.matchBefore(/\.\w*$/);
  if (dotMatch) {
    return {
      from: dotMatch.from + 1,
      options: SWIFT_DOT_COMPLETIONS,
      validFor: /^\w*$/
    };
  }

  const atMatch = context.matchBefore(/@\w*$/);
  if (atMatch) {
    return {
      from: atMatch.from,
      options: SWIFT_ATTRIBUTES,
      validFor: /^@\w*$/
    };
  }

  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit)) {
    return null;
  }

  return {
    from: word.from,
    options: SWIFT_TOP_LEVEL_COMPLETIONS,
    validFor: /^\w*$/
  };
}

/**
 * Universal in-document word completion extension so any identifier already written
 * in the editor buffer is suggested across all languages.
 */
export function universalWordCompletionExtension(): Extension {
  return EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]);
}

/**
 * Language-specific completion extension for Kotlin combining keywords, stdlib,
 * Coroutines/Flow, Jetpack Compose, snippets, and in-document identifiers.
 */
export function kotlinAutocompletionExtension(): Extension {
  return EditorState.languageData.of(() => [
    { autocomplete: kotlinCompletionSource },
    { autocomplete: completeAnyWord }
  ]);
}

/**
 * Language-specific completion extension for Swift & SwiftUI.
 */
export function swiftAutocompletionExtension(): Extension {
  return EditorState.languageData.of(() => [
    { autocomplete: swiftCompletionSource },
    { autocomplete: completeAnyWord }
  ]);
}
