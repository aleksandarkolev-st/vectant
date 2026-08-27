# Vectant — GPU-as-a-Device

## Concept

Vectant is a system for temporarily attaching a remote physical GPU to a user's local computer.

The user's computer remains the computer.

Their operating system, CPU, RAM, SSD, applications, games, files, development environment, peripherals, and local state all stay on their own machine.

Vectant only provides the GPU.

The target user experience is:

```bash
vectant rent rtx5090 --hours 2
```

Vectant finds an available GPU, reserves it, connects it to the user's machine, and makes it available to the operating system.

From that point onward, the user should be able to use the GPU as naturally as possible, as if an additional graphics card had been installed in the machine.

The user does **not** enter a remote VM.

The user does **not** use a remote desktop.

The user does **not** upload their application to another computer.

The user does **not** write Vectant-specific code to perform GPU calculations.

The Vectant API is used to **acquire and attach the GPU**, not to use the GPU.

---

## Core Principle

> The user calls Vectant to acquire a GPU. Once acquired, they use their computer normally.

Applications should continue using their normal interfaces:

- CUDA
- DirectX
- Vulkan
- OpenGL
- other GPU compute or graphics APIs

Vectant should sit underneath those applications.

The ideal abstraction is:

```text
Before:

Local computer
├── CPU
├── RAM
├── SSD
└── Integrated / local GPU


After renting:

Local computer
├── CPU
├── RAM
├── SSD
├── Integrated / local GPU
└── Vectant GPU — RTX 5090 backend
```

The physical RTX 5090 may be located in a Vectant datacenter, a partner datacenter, a GPU cloud provider, or eventually another approved host.

To the user, that physical location should matter as little as possible.

---

## Example User Experience

A developer could request a GPU through an API:

```http
POST /v1/gpus/rent

{
  "gpu": "RTX 5090",
  "duration": 7200,
  "region": "eu",
  "optimize": "latency"
}
```

Or through a CLI:

```bash
$ vectant rent rtx5090 --hours 2

Searching...
GPU found: RTX 5090
VRAM: 32 GB
Latency: 8.1 ms
Price: €0.84/hour

Attaching...

✓ GPU attached
```

At this point, Vectant's control API is mostly finished with its job.

The user then launches whatever software they want:

```text
PyTorch
Blender
Unreal Engine
DaVinci Resolve
Stable Diffusion
CAD software
games
custom CUDA software
other GPU applications
```

Ideally, existing applications require no Vectant integration.

For example:

```python
import torch

print(torch.cuda.is_available())
# True
```

The goal is that the program sees usable GPU capability without the developer having to rewrite the application around a Vectant SDK.

---

## What Vectant Is Not

Vectant is **not cloud gaming**.

Traditional cloud gaming:

```text
REMOTE MACHINE

Game
CPU
RAM
GPU
     │
     ▼
Video stream
     │
     ▼
LOCAL MACHINE
```

Vectant:

```text
LOCAL MACHINE

Game / application
CPU
RAM
SSD
OS
     │
     ▼
GPU work
     │
     ▼
Vectant transport
     │
     ▼
REMOTE PHYSICAL GPU
     │
     ▼
results
     │
     ▼
LOCAL MACHINE
```

The application itself remains local.

Vectant is also **not a normal GPU cloud instance**.

With a traditional GPU cloud, the user provisions a remote machine and moves their workload there.

Vectant instead tries to make remote acceleration part of the user's existing machine.

---

## Product Analogy

The business-layer analogy is similar to OpenRouter.

OpenRouter hides which model provider actually executes a request.

Vectant would hide where the GPU physically exists.

```text
                         ┌── Vectant infrastructure
                         ├── GPU cloud A
User ── Vectant ─────────┼── GPU cloud B
                         ├── regional datacenter
                         └── approved GPU host
```

Vectant could route based on:

- GPU model
- VRAM
- price
- availability
- geographic distance
- measured latency
- bandwidth
- host reliability
- workload requirements

But technically, the more important concept is different:

> Vectant turns remote GPUs into attachable computing devices.

Possible descriptions:

- GPU-as-a-Device
- Network GPU
- Remote GPU attachment
- GPU over network
- Network GPU bus

---

# High-Level System Model

Vectant likely needs two major planes.

## 1. Control Plane

The control plane handles:

- authentication
- GPU discovery
- pricing
- reservations
- billing
- host selection
- region selection
- connection authorization
- session lifecycle
- health checks
- disconnection

Example:

```text
User
 │
 ▼
Vectant API
 │
 ├── Find compatible GPU
 ├── Select optimal host
 ├── Reserve GPU
 ├── Authenticate both sides
 └── Establish secure connection
```

Once the GPU is attached, the control plane should not need to sit in the performance-critical path.

---

## 2. Data Plane

The data plane carries the actual GPU interaction.

Conceptually:

```text
LOCAL COMPUTER

Application
    │
    ▼
CUDA / DirectX / Vulkan / graphics stack
    │
    ▼
Vectant local driver/runtime
    │
    │
    ║ encrypted low-latency connection
    │
    ▼
Vectant host service
    │
    ▼
Native GPU driver
    │
    ▼
Physical GPU
```

The exact placement of the Vectant software in the operating-system and driver stack is one of the main architecture questions.

---

# The Core Technical Problem

A GPU is normally connected through a very fast, very low-latency local interconnect such as PCIe.

Vectant introduces a network between the CPU and GPU.

That means a naive implementation will not work.

The system cannot simply translate every tiny local GPU transaction into a network packet.

A local system may perform enormous numbers of interactions between:

- CPU
- system RAM
- GPU driver
- command queues
- GPU memory
- synchronization primitives
- GPU kernels
- shaders

Network latency is orders of magnitude higher than local hardware latency.

Therefore, the key technical problem is:

> How can Vectant preserve the software abstraction of a local GPU while minimizing round trips between the local machine and the remote GPU?

---

# Likely Design Principle: Keep State Remote

Large assets should not constantly move across the network.

Example:

```text
BAD

Every frame:
Local PC → upload texture
Local PC → upload geometry
GPU → render
GPU → return data
```

Instead:

```text
BETTER

Initialization:
Local PC → texture → remote VRAM
Local PC → geometry → remote VRAM
Local PC → shaders → remote GPU

Then:

Frame 1 → small command/update
Frame 2 → small command/update
Frame 3 → small command/update
```

Vectant may need to maintain persistent remote GPU state for the lifetime of a session.

This can include:

- GPU allocations
- textures
- shaders
- model weights
- vertex buffers
- compute buffers
- compiled kernels
- intermediate results
- caches

---

# Remote VRAM

One possible abstraction is a remote VRAM mapping.

The application believes it has created GPU resources.

Vectant maps those resources to physical allocations on the remote GPU.

Conceptually:

```text
LOCAL VIEW                         REMOTE REALITY

GPU buffer A ────────────────────► RTX 5090 VRAM allocation
Texture B    ────────────────────► RTX 5090 VRAM allocation
Model C      ────────────────────► RTX 5090 VRAM allocation
```

Vectant would need to track:

- allocation
- ownership
- addressing
- residency
- synchronization
- uploads
- downloads
- invalidation
- lifetime
- process isolation

This may become one of the most important parts of the system.

---

# Command Batching

Network round trips are expensive.

Vectant should therefore investigate whether GPU operations can be:

- buffered
- batched
- reordered where safe
- compressed
- predicted
- asynchronously submitted
- executed without unnecessary acknowledgements

Instead of:

```text
command
wait
command
wait
command
wait
```

Vectant should aim for something closer to:

```text
command
command
command
command
        ↓
batch
        ↓
network
        ↓
remote GPU execution
```

The ability to reduce synchronization barriers may determine which workloads perform well.

---

# Direct Client-to-Host Connection

The Vectant central service should ideally not proxy all GPU traffic.

Preferred model:

```text
Control:

Client → Vectant API → Host selection


Data:

Client ═══════════════ Host
       direct secure
       connection
```

This minimizes:

- additional latency
- bandwidth cost
- central bottlenecks
- unnecessary infrastructure

Vectant still manages authentication and authorization, but performance-sensitive traffic can travel directly between the client and GPU host where possible.

---

# Host Architecture

A Vectant host could run something similar to:

```text
vectant-host
```

Responsibilities may include:

- authenticate sessions
- expose permitted GPU resources
- receive GPU commands
- manage GPU memory
- communicate with the native NVIDIA/AMD driver
- isolate customers
- enforce quotas
- report health and utilization
- meter usage
- terminate sessions safely

Conceptually:

```text
Vectant Client
      │
      ▼
Network
      │
      ▼
Vectant Host Service
      │
      ▼
GPU scheduling / isolation layer
      │
      ▼
Native GPU driver
      │
      ▼
Physical GPU
```

---

# Client Architecture

The client is probably the most difficult component.

It may eventually need some combination of:

- kernel driver
- user-mode driver
- runtime
- virtual device
- transport engine
- memory manager
- command serializer
- resource cache
- telemetry
- authentication agent

The client should attempt to expose a normal GPU-like interface to the operating system and applications.

The architectural goal is transparency.

Applications should ideally not need to know that the hardware is remote.

---

# The API Should Not Be the Compute Interface

This distinction is fundamental.

Wrong model:

```python
vectant.run_cuda(...)
vectant.render(...)
vectant.execute_shader(...)
```

That would require applications to integrate directly with Vectant.

Preferred model:

```python
gpu = vectant.rent("rtx5090")
gpu.attach()
```

Then the normal application stack takes over.

```python
# ordinary software
model.to("cuda")
```

Vectant becomes infrastructure rather than an application framework.

---

# Workload Differences

Not every workload will tolerate remote GPU access equally well.

## Strong Early Candidates

Compute-heavy workloads with relatively little CPU↔GPU synchronization may be easiest:

- AI inference
- AI training
- Stable Diffusion
- video generation
- CUDA compute
- scientific computing
- rendering
- encoding
- batch processing

These workloads can often upload significant data once, perform large amounts of GPU work remotely, and download relatively small results.

---

## Harder Workloads

Interactive applications may require much more synchronization:

- Blender viewport
- CAD
- Unreal Engine editor
- real-time graphics
- games

These could still be valuable, but latency becomes much more important.

---

## Extremely Difficult Workloads

Competitive games may represent one of the hardest cases because of:

- frame deadlines
- constant CPU/GPU synchronization
- anti-cheat
- driver assumptions
- shader compilation
- frame pacing
- very low latency requirements

Gaming should therefore be viewed as an important potential use case, but probably not the first technical proof.

---

# First Technical Milestone

The first version should prove the core idea with the narrowest technically useful workload.

A possible milestone:

> Run an unmodified or minimally modified local CUDA workload while its GPU computation executes on a remote NVIDIA GPU.

Example environment:

```text
LOCAL LAPTOP

Python
PyTorch
CPU
RAM
project files

        │
        ▼
Vectant
        │
        ▼

REMOTE HOST

RTX 5090
```

Desired experience:

```python
import torch

device = torch.device("cuda")
model = model.to(device)
```

The application remains local while GPU execution happens remotely.

If that can be made sufficiently transparent and performant, it validates the most important part of the idea.

---

# Possible Development Path

A reasonable sequence to investigate could be:

```text
1. Remote GPU compute prototype
          ↓
2. CUDA compatibility
          ↓
3. Remote memory management
          ↓
4. Transparent application support
          ↓
5. Better OS/device integration
          ↓
6. Rendering workloads
          ↓
7. Vulkan / graphics experimentation
          ↓
8. DirectX experimentation
          ↓
9. Interactive gaming
```

This does not mean Vectant should permanently be CUDA-specific.

It means CUDA may provide a constrained environment in which the fundamental transport, memory, scheduling, and compatibility problems can be solved first.

---

# Important Architectural Questions

The architecture team should investigate these before choosing an implementation.

## Device Model

- Should the remote GPU appear as an operating-system GPU device?
- Should it be a custom Vectant adapter?
- Can existing vendor APIs remain compatible?
- Which parts require kernel-level integration?
- Which parts can live in user space?

## API Compatibility

- How can existing CUDA applications work?
- How could DirectX support work?
- How could Vulkan support work?
- What assumptions do applications make about local GPU memory?
- Which APIs expose behaviors that cannot realistically be reproduced over a network?

## Memory

- Where does GPU memory physically live?
- How are allocations represented locally?
- How are pointers and addresses mapped?
- How are CPU↔GPU transfers handled?
- Can memory be prefetched?
- Can frequently used resources remain cached remotely?

## Synchronization

- Which operations require immediate acknowledgement?
- Which operations can be asynchronous?
- Which synchronization points create unavoidable network stalls?
- Can command streams be batched without changing observable behavior?

## Networking

- TCP, UDP, QUIC, RDMA, or a custom protocol?
- What latency is acceptable?
- What bandwidth is required?
- How should packet loss be handled?
- Can data be compressed?
- When does compression cost more than it saves?
- Can the client automatically choose nearby hosts?

## Security

The remote host is executing operations originating from an untrusted client.

The client may also be sending:

- proprietary models
- shaders
- project data
- textures
- business data
- application assets

Vectant therefore needs strong guarantees around:

- isolation
- encryption
- authentication
- memory clearing
- tenant separation
- host trust
- abuse prevention

## Multi-Tenancy

Questions include:

- Does one user rent an entire GPU?
- Can a GPU be divided?
- How is VRAM reserved?
- How are workloads isolated?
- How predictable is performance?
- Can one customer's workload affect another?

Initial versions may be much simpler if one session reserves one entire GPU.

## Failure Handling

What happens if:

- the network disconnects?
- the host crashes?
- the user's laptop sleeps?
- the GPU driver resets?
- the host loses power?
- latency suddenly increases?
- the session expires while an application is running?

A remote hardware abstraction needs well-defined failure semantics.

---

# Routing Layer

Once remote GPU attachment works, Vectant can build an OpenRouter-like market on top.

A rental request might specify:

```json
{
  "gpu": ">= RTX 4090",
  "vram": ">= 24GB",
  "region": "EU",
  "duration": "2h",
  "optimize": "latency"
}
```

Vectant could score available hosts using something similar to:

```text
score =
    GPU compatibility
  + latency
  + bandwidth
  + price
  + availability
  + reliability
  + host reputation
```

Different workloads may need different routing strategies.

AI training may prioritize price.

Gaming may prioritize latency.

Rendering may prioritize price/performance.

Large models may prioritize VRAM.

---

# Supply

Vectant could eventually aggregate GPUs from multiple sources.

```text
Vectant
├── owned infrastructure
├── GPU cloud providers
├── datacenter partners
├── hosting companies
└── approved independent hosts
```

The customer should not need to manage separate accounts with each underlying provider.

Vectant becomes:

- identity layer
- billing layer
- routing layer
- compatibility layer
- device abstraction layer

---

# Potential Moat

The marketplace itself is not necessarily the hardest thing to copy.

The strongest technical moat would likely be:

1. Vectant remote GPU driver/runtime
2. Vectant GPU transport protocol
3. Remote GPU memory management
4. Transparent compatibility with existing applications
5. Low-latency scheduling and routing
6. Host-side isolation and execution
7. Performance optimizations accumulated across workloads

If Vectant makes arbitrary remote GPUs behave sufficiently like local hardware, the routing marketplace becomes much more valuable.

---

# Product Goal

The end state should feel simple.

```bash
$ vectant rent rtx5090 --hours 2
✓ GPU attached
```

The user should then stop thinking about Vectant.

They should simply use their computer.

Two hours later:

```text
Vectant RTX 5090 disconnected.
Session duration: 2h
Billing stopped.
```

The complexity belongs inside the infrastructure.

---

# One-Sentence Definition

> Vectant is a network GPU platform that lets users temporarily attach remote physical GPUs to their existing computers and use them through normal software interfaces without moving their applications into a cloud VM.

---

# North Star

Vectant succeeds when the physical location of a GPU becomes an implementation detail.

Today:

```text
I need a powerful GPU
→ buy one
→ install one
```

or:

```text
I need a powerful GPU
→ rent a cloud machine
→ move my work to that machine
```

Vectant aims for:

```text
I need a powerful GPU
→ attach one
→ continue using my own computer
```

That is the idea the architecture should be designed around.
